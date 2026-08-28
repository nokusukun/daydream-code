import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { boot, type BootResult } from "@daydream-code/boot";
import { eq } from "@daydream-code/store/drizzle";
import { schema } from "@daydream-code/store";
import type { SessionId } from "@daydream-code/shared";

/**
 * The two thread-continuity features: switching the agent behind an existing
 * thread (`setModel`), and handing a thread's work to a new one (`handoff`).
 * The mock driver keeps no provider-side state, which makes it exactly the
 * shape of a freshly-switched driver — so these tests also pin the journal
 * replay that a real switch depends on.
 */

let dirs: string[] = [];
let systems: BootResult[] = [];

async function bootProject(
  script: Array<{ turn: string } | { tool: string; args?: unknown }> = [],
): Promise<BootResult> {
  const dir = mkdtempSync(join(tmpdir(), "ddc-handoff-"));
  dirs.push(dir);
  const result = await boot({
    projectRoot: dir,
    overrides: [
      { id: "driver-mock", disabled: false, config: { id: "mock", script } },
      { id: "driver-claude", disabled: true },
    ],
  });
  systems.push(result);
  return result;
}

afterEach(async () => {
  for (const system of systems) {
    await system.app.dispose(system.app.rootFiber).catch(() => undefined);
  }
  systems = [];
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function resumeTokenRow(system: BootResult, id: string) {
  return system.ctx.store.db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, `driver_resume:${id}`))
    .get();
}

function registerOther(system: BootResult): void {
  system.ctx.drivers.register(system.ctx, {
    id: "other",
    run: async () => ({
      summary: "",
      tldr: "",
      usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
    }),
  });
}

describe("setModel — switching the agent behind a thread", () => {
  it("updates the row, journals the change, and the next run carries it", async () => {
    const system = await bootProject([{ turn: "working" }]);
    const first = await system.ctx.sessions.dispatch({
      task: "start here",
      driver: "mock",
      modelId: "mock-fast",
    });
    await first.done;

    const updated = system.ctx.sessions.setModel(first.record.id, {
      modelId: "mock-slow",
      effort: "high",
    });
    expect(updated.modelId).toBe("mock-slow");
    expect(updated.effort).toBe("high");
    expect(updated.driver).toBe("mock");

    const changed = system.ctx.journal
      .read({ sessionId: first.record.id })
      .filter((event) => event.type === "model_changed");
    expect(changed).toHaveLength(1);
    const payload = changed[0]!.payload as {
      from: { modelId: string | null };
      to: { modelId: string | null; effort: string | null };
      contextRebuilt: boolean;
    };
    expect(payload.from.modelId).toBe("mock-fast");
    expect(payload.to.modelId).toBe("mock-slow");
    expect(payload.to.effort).toBe("high");
    // Same driver: the provider still holds the history.
    expect(payload.contextRebuilt).toBe(false);

    const second = await system.ctx.sessions.continueSession(
      first.record.id,
      "keep going",
    );
    expect(second.record.modelId).toBe("mock-slow");
    expect(second.record.effort).toBe("high");
    await second.done;
    const started = system.ctx.journal
      .read({ sessionId: first.record.id })
      .filter((event) => event.type === "session_started")
      .map((event) => event.payload as { modelId?: string | null });
    expect(started[1]?.modelId).toBe("mock-slow");
  });

  it("is a no-op when nothing changes — no journal noise", async () => {
    const system = await bootProject();
    const handle = await system.ctx.sessions.dispatch({
      task: "steady",
      driver: "mock",
    });
    await handle.done;
    system.ctx.sessions.setModel(handle.record.id, { driver: "mock" });
    const changed = system.ctx.journal
      .read({ sessionId: handle.record.id })
      .filter((event) => event.type === "model_changed");
    expect(changed).toHaveLength(0);
  });

  it("sets the resume token aside only when the driver changes", async () => {
    const system = await bootProject();
    const handle = await system.ctx.sessions.dispatch({
      task: "with a token",
      driver: "mock",
    });
    await handle.done;
    const id = handle.record.id as string;
    // The mock driver mints no token; plant one the way a real driver would.
    system.ctx.store.db
      .insert(schema.settings)
      .values({
        key: `driver_resume:${id}`,
        valueJson: JSON.stringify("provider-handle"),
        updatedAt: new Date().toISOString(),
      })
      .run();

    // A model change within the driver keeps it: the provider's history is
    // still redeemable.
    system.ctx.sessions.setModel(handle.record.id, { modelId: "mock-slow" });
    expect(resumeTokenRow(system, id)).toBeDefined();

    // A driver change removes it from the active slot: the new provider cannot
    // redeem the old handle, and its absence is what triggers journal replay.
    // It remains in the short-lived undo slot until the next run starts.
    registerOther(system);
    system.ctx.sessions.setModel(handle.record.id, { driver: "other" });
    expect(resumeTokenRow(system, id)).toBeUndefined();
    const changed = system.ctx.journal
      .read({ sessionId: handle.record.id })
      .filter((event) => event.type === "model_changed");
    expect(
      (changed[changed.length - 1]!.payload as { contextRebuilt: boolean })
        .contextRebuilt,
    ).toBe(true);
  });

  it("undoes a pending context rebuild with the original provider context", async () => {
    const system = await bootProject();
    const handle = await system.ctx.sessions.dispatch({
      task: "keep this context",
      driver: "mock",
      modelId: "mock-fast",
      effort: "high",
    });
    await handle.done;
    const id = handle.record.id as string;
    system.ctx.store.db
      .insert(schema.settings)
      .values({
        key: `driver_resume:${id}`,
        valueJson: JSON.stringify("original-provider-handle"),
        updatedAt: new Date().toISOString(),
      })
      .run();
    registerOther(system);

    system.ctx.sessions.setModel(handle.record.id, {
      driver: "other",
      modelId: "other-fast",
      effort: "low",
    });
    const restored = system.ctx.sessions.undoModelChange(handle.record.id);

    expect(restored).toMatchObject({
      driver: "mock",
      modelId: "mock-fast",
      effort: "high",
    });
    expect(JSON.parse(resumeTokenRow(system, id)!.valueJson)).toBe(
      "original-provider-handle",
    );
    const changed = system.ctx.journal
      .read({ sessionId: handle.record.id })
      .filter((event) => event.type === "model_changed");
    expect(changed).toHaveLength(2);
    expect(changed[1]!.payload).toMatchObject({
      contextRebuilt: false,
      undo: true,
      to: { driver: "mock", modelId: "mock-fast", effort: "high" },
    });
    expect(() => system.ctx.sessions.undoModelChange(handle.record.id)).toThrow(
      /no pending context rebuild/,
    );
  });

  it("retires context undo as soon as the next run starts", async () => {
    const system = await bootProject();
    const handle = await system.ctx.sessions.dispatch({
      task: "first provider",
      driver: "mock",
    });
    await handle.done;
    registerOther(system);
    system.ctx.sessions.setModel(handle.record.id, { driver: "other" });

    const continued = await system.ctx.sessions.continueSession(
      handle.record.id,
      "consume rebuilt context",
    );
    await continued.done;
    expect(() => system.ctx.sessions.undoModelChange(handle.record.id)).toThrow(
      /no pending context rebuild/,
    );
  });

  it("refuses an unknown driver before anything is written", async () => {
    const system = await bootProject();
    const handle = await system.ctx.sessions.dispatch({
      task: "stay put",
      driver: "mock",
    });
    await handle.done;
    expect(() =>
      system.ctx.sessions.setModel(handle.record.id, { driver: "nope" }),
    ).toThrow(/not registered/);
    expect(system.ctx.sessions.get(handle.record.id)?.driver).toBe("mock");
  });

  it("refuses a live thread", async () => {
    const system = await bootProject();
    const handle = await system.ctx.sessions.dispatch({
      task: "busy",
      driver: "mock",
    });
    await handle.done;
    // Simulate the live state directly: a scripted mock run completes too
    // fast to catch in flight, but the status guard is what refuses either way.
    system.ctx.store.db
      .update(schema.sessions)
      .set({ status: "running" })
      .where(eq(schema.sessions.id, handle.record.id))
      .run();
    expect(() =>
      system.ctx.sessions.setModel(handle.record.id, { modelId: "other" }),
    ).toThrow(/switch the agent/);
  });

  it("clears model and effort back to the driver default with explicit null", async () => {
    const system = await bootProject();
    const handle = await system.ctx.sessions.dispatch({
      task: "pinned",
      driver: "mock",
      modelId: "mock-fast",
      effort: "low",
    });
    await handle.done;
    const updated = system.ctx.sessions.setModel(handle.record.id, {
      modelId: null,
      effort: null,
    });
    expect(updated.modelId).toBeNull();
    expect(updated.effort).toBeNull();
  });
});

describe("journal replay when no provider-side history exists", () => {
  it("seeds a token-less revive with the thread's own transcript", async () => {
    const system = await bootProject([{ turn: "the answer is 42" }]);
    const first = await system.ctx.sessions.dispatch({
      task: "find the answer",
      driver: "mock",
    });
    await first.done;
    const second = await system.ctx.sessions.continueSession(
      first.record.id,
      "now explain it",
    );
    await second.done;
    const started = system.ctx.journal
      .read({ sessionId: first.record.id })
      .filter((event) => event.type === "session_started")
      .map(
        (event) =>
          event.payload as { transcriptMessages?: number; resumed: boolean },
      );
    expect(started).toHaveLength(2);
    // Fresh dispatch: empty journal, nothing to replay.
    expect(started[0]?.transcriptMessages).toBeUndefined();
    // The revive replays what the first run said.
    expect(started[1]?.transcriptMessages).toBeGreaterThan(0);
  });
});

describe("handoff — a new thread carrying this one's work", () => {
  it("transcript mode: the new task embeds the source's replayed turns", async () => {
    const system = await bootProject([{ turn: "the answer is 42" }]);
    const source = await system.ctx.sessions.dispatch({
      task: "find the answer",
      driver: "mock",
    });
    await source.done;

    const handle = await system.ctx.sessions.handoff(source.record.id, {
      mode: "transcript",
      driver: "mock",
    });
    expect(handle.record.id).not.toBe(source.record.id);
    expect(handle.record.driver).toBe("mock");
    expect(handle.record.task).toContain(
      `Handed off from thread "${source.record.name}"`,
    );
    expect(handle.record.task).toContain("the answer is 42");
    expect(handle.record.task).toContain("### Its transcript");
    await handle.done;

    // The source records where its work went.
    const handoffs = system.ctx.journal
      .read({ sessionId: source.record.id })
      .filter((event) => event.type === "handoff");
    expect(handoffs).toHaveLength(1);
    const payload = handoffs[0]!.payload as {
      toSessionId: string;
      mode: string;
    };
    expect(payload.toSessionId).toBe(handle.record.id);
    expect(payload.mode).toBe("transcript");

    // And the source itself is untouched.
    const after = system.ctx.sessions.get(source.record.id)!;
    expect(after.status).toBe("completed");
  });

  it("summary mode: the new task embeds the summarizer's digest", async () => {
    const system = await bootProject([{ turn: "conclusions were reached" }]);
    const source = await system.ctx.sessions.dispatch({
      task: "reach conclusions",
      driver: "mock",
    });
    await source.done;
    const handle = await system.ctx.sessions.handoff(source.record.id, {
      mode: "summary",
    });
    expect(handle.record.task).toContain("### Summary of its work");
    // The mechanical summarizer always names the task.
    expect(handle.record.task).toContain("reach conclusions");
    await handle.done;
  });

  it("a supplied instruction leads the task and drives the title", async () => {
    const system = await bootProject([{ turn: "partial work" }]);
    const source = await system.ctx.sessions.dispatch({
      task: "start something",
      driver: "mock",
    });
    await source.done;
    const handle = await system.ctx.sessions.handoff(source.record.id, {
      mode: "transcript",
      task: "Finish the refactor with more care",
    });
    expect(handle.record.task.startsWith("Finish the refactor with more care")).toBe(
      true,
    );
    expect(handle.record.title.toLowerCase()).toContain("finish the refactor");
    await handle.done;
  });

  it("refuses an unknown source", async () => {
    const system = await bootProject();
    await expect(
      system.ctx.sessions.handoff("ses_missing" as SessionId, {
        mode: "transcript",
      }),
    ).rejects.toThrow(/unknown session/);
  });
});
