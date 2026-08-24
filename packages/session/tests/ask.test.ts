import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { boot, type BootResult } from "@daydream-code/boot";
import type { PendingQuestion } from "@daydream-code/questions";
import type { JournalEvent, SessionRecord } from "@daydream-code/shared";

/**
 * End-to-end for the blocking-question path, through the real composed system
 * with the mock driver. The mock awaits `tool.execute` exactly like the Claude
 * adapter's MCP callback does, so a blocked `ask_user` call blocks a real run.
 */

let dirs: string[] = [];
let systems: BootResult[] = [];

const QUESTION = "Store blobs in the project or in a shared cache?";

function askStep(overrides?: Record<string, unknown>) {
  return {
    tool: "ask_user",
    args: {
      questions: [
        {
          question: QUESTION,
          header: "Storage",
          options: [
            { label: "In project", description: "Survives a sandbox boundary." },
            { label: "Shared cache", description: "Dedupes across projects." },
          ],
          ...overrides,
        },
      ],
    },
  };
}

async function bootProject(script: unknown[]): Promise<BootResult> {
  const dir = mkdtempSync(join(tmpdir(), "ddc-ask-"));
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

/**
 * Resolve once the session is actually blocked, rather than racing a timer.
 * The listener has to be registered before dispatch: the mock driver reaches
 * the tool call in the same tick that `dispatch` resolves, so subscribing
 * afterwards misses the event and hangs.
 */
function whenAsked(ctx: BootResult["ctx"]): Promise<PendingQuestion> {
  const already = ctx.questions.pending()[0];
  if (already) return Promise.resolve(already);
  return new Promise((resolve) => {
    const off = ctx.on("question/asked", (pending) => {
      off();
      resolve(pending);
    });
  });
}

/** Dispatch and return once the run is parked on its question. */
async function dispatchBlocked(
  ctx: BootResult["ctx"],
): Promise<{ handle: Awaited<ReturnType<BootResult["ctx"]["sessions"]["dispatch"]>>; pending: PendingQuestion }> {
  const asked = whenAsked(ctx);
  const handle = await ctx.sessions.dispatch({ task: "pick a store", driver: "mock" });
  return { handle, pending: await asked };
}

const typesOf = (events: JournalEvent[]) => events.map((e) => e.type);

afterEach(async () => {
  for (const system of systems) {
    await system.app.dispose(system.app.rootFiber).catch(() => undefined);
  }
  systems = [];
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("ask_user end to end", () => {
  it("registers the tool on the harness registry", async () => {
    const { ctx } = await bootProject([]);
    expect(ctx.tools.get("ask_user")).toBeDefined();
  });

  it("blocks the run and flags the session `waiting`", async () => {
    const { ctx } = await bootProject([askStep(), { turn: "done" }]);
    const { handle, pending } = await dispatchBlocked(ctx);

    expect(ctx.sessions.get(handle.record.id)!.status).toBe("waiting");
    expect(pending.questions[0]!.id).toBe(QUESTION);
    expect(pending.questions[0]!.header).toBe("Storage");
    expect(typesOf(ctx.journal.read({ sessionId: handle.record.id }))).toContain(
      "question_asked",
    );

    ctx.questions.settle(pending.requestId, {
      kind: "answered",
      answers: { [QUESTION]: "In project" },
    });
    const final = await handle.done;
    expect(final.status).toBe("completed");
  });

  it("returns the chosen answers to the model as the tool result", async () => {
    const { ctx } = await bootProject([askStep(), { turn: "done" }]);
    const { handle, pending } = await dispatchBlocked(ctx);
    ctx.questions.settle(pending.requestId, {
      kind: "answered",
      answers: { [QUESTION]: "Shared cache" },
    });
    await handle.done;

    const result = ctx.journal
      .read({ sessionId: handle.record.id })
      .find((e) => e.type === "tool_result")!;
    const payload = result.payload as { result: { status: string; answers: Record<string, string> } };
    expect(payload.result.status).toBe("answered");
    expect(payload.result.answers[QUESTION]).toBe("Shared cache");
  });

  it("goes back to `running` once answered", async () => {
    const { ctx } = await bootProject([askStep(), { turn: "done" }]);
    const { handle, pending } = await dispatchBlocked(ctx);

    const statuses: string[] = [];
    ctx.on("session/updated", (s: SessionRecord) => statuses.push(s.status));
    ctx.questions.settle(pending.requestId, { kind: "declined" });
    await handle.done;

    expect(statuses[0]).toBe("running");
  });

  it("routes a mid-flight message to the question instead of the injection queue", async () => {
    const { ctx } = await bootProject([askStep(), { turn: "done" }]);
    const { handle } = await dispatchBlocked(ctx);

    // The injection queue only drains at turn boundaries, and the turn cannot
    // reach one while blocked — so this has to land as the answer.
    await ctx.sessions.continueSession(handle.record.id, "neither, use /tmp");
    await handle.done;

    const events = ctx.journal.read({ sessionId: handle.record.id });
    const result = events.find((e) => e.type === "tool_result")!;
    const payload = result.payload as { result: { status: string; reply: string } };
    expect(payload.result.status).toBe("replied");
    expect(payload.result.reply).toBe("neither, use /tmp");
    // and it did NOT also arrive as a separate injected user message
    expect(typesOf(events)).not.toContain("user_injected");
  });

  it("tells the model to proceed on its own recommendation when declined", async () => {
    const { ctx } = await bootProject([askStep(), { turn: "done" }]);
    const { handle, pending } = await dispatchBlocked(ctx);
    ctx.questions.settle(pending.requestId, { kind: "declined" });
    await handle.done;

    const result = ctx.journal
      .read({ sessionId: handle.record.id })
      .find((e) => e.type === "tool_result")!;
    const payload = result.payload as { result: { status: string; guidance: string } };
    expect(payload.result.status).toBe("declined");
    expect(payload.result.guidance).toMatch(/assumption/);
  });

  it("releases the block when the session is stopped mid-question", async () => {
    const { ctx } = await bootProject([askStep(), { turn: "done" }]);
    const { handle } = await dispatchBlocked(ctx);

    await ctx.sessions.stop(handle.record.id);
    const final = await handle.done;

    expect(final.status).toBe("killed");
    expect(ctx.questions.pending(handle.record.id)).toHaveLength(0);
    const settled = ctx.journal
      .read({ sessionId: handle.record.id })
      .find((e) => e.type === "question_settled")!;
    expect((settled.payload as { kind: string }).kind).toBe("cancelled");
  });

  it("settles before the session ends, so the record reads in order", async () => {
    const { ctx } = await bootProject([askStep(), { turn: "done" }]);
    const { handle } = await dispatchBlocked(ctx);
    await ctx.sessions.stop(handle.record.id);
    await handle.done;

    const types = typesOf(ctx.journal.read({ sessionId: handle.record.id }));
    expect(types.indexOf("question_settled")).toBeLessThan(types.indexOf("session_ended"));
  });

  it("rejects a question with too few options rather than asking it", async () => {
    const { ctx } = await bootProject([
      { tool: "ask_user", args: { questions: [{ question: "one way?", header: "H", options: [{ label: "only", description: "sole" }] }] } },
      { turn: "done" },
    ]);
    const handle = await ctx.sessions.dispatch({ task: "pick a store", driver: "mock" });
    const final = await handle.done;

    expect(final.status).toBe("completed");
    const error = ctx.journal
      .read({ sessionId: handle.record.id })
      .find((e) => e.type === "tool_error")!;
    expect((error.payload as { error: string }).error).toMatch(/2-4 options/);
  });

  it("caps a call at four questions", async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      question: `q${i}?`,
      header: "H",
      options: [
        { label: "a", description: "" },
        { label: "b", description: "" },
      ],
    }));
    const { ctx } = await bootProject([
      { tool: "ask_user", args: { questions: many } },
      { turn: "done" },
    ]);
    const handle = await ctx.sessions.dispatch({ task: "pick a store", driver: "mock" });
    await handle.done;
    const error = ctx.journal
      .read({ sessionId: handle.record.id })
      .find((e) => e.type === "tool_error")!;
    expect((error.payload as { error: string }).error).toMatch(/at most 4 questions/);
  });

  it("truncates an over-long header rather than refusing the question", async () => {
    const { ctx } = await bootProject([
      askStep({ header: "a-very-long-header-indeed" }),
      { turn: "done" },
    ]);
    const { handle, pending } = await dispatchBlocked(ctx);
    expect(pending.questions[0]!.header).toHaveLength(12);
    ctx.questions.settle(pending.requestId, { kind: "declined" });
    await handle.done;
  });

  it("kills a session left `waiting` by a dead process on the next boot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ddc-ask-"));
    dirs.push(dir);
    const first = await boot({
      projectRoot: dir,
      overrides: [
        { id: "driver-mock", disabled: false, config: { id: "mock", script: [askStep()] } },
        { id: "driver-claude", disabled: true },
      ],
    });
    const asked = whenAsked(first.ctx);
    const handle = await first.ctx.sessions.dispatch({ task: "pick a store", driver: "mock" });
    await asked;
    expect(first.ctx.sessions.get(handle.record.id)!.status).toBe("waiting");

    // Simulate the process dying with the promise still held: drop the app
    // without settling, leaving a `waiting` row behind.
    first.ctx.store.db.$client.close();

    const second = await boot({
      projectRoot: dir,
      overrides: [
        { id: "driver-mock", disabled: false, config: { id: "mock", script: [] } },
        { id: "driver-claude", disabled: true },
      ],
    });
    systems.push(second);
    expect(second.ctx.sessions.get(handle.record.id)!.status).toBe("killed");
  });
});
