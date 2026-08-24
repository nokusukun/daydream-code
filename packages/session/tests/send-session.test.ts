import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { boot, type BootResult } from "@daydream-code/boot";
import type { JournalEvent } from "@daydream-code/shared";

/**
 * End-to-end for `send_session` — the non-blocking half of sibling contact —
 * through the real composed system with the mock driver.
 */

let dirs: string[] = [];
let systems: BootResult[] = [];

async function bootProject(a: unknown[], b: unknown[]): Promise<BootResult> {
  const dir = mkdtempSync(join(tmpdir(), "ddc-send-"));
  dirs.push(dir);
  const result = await boot({
    projectRoot: dir,
    overrides: [
      { id: "driver-claude", disabled: true },
      { id: "driver-mock", disabled: false, config: { id: "mock-a", script: a } },
      {
        id: "driver-mock-b",
        name: "@daydream-code/driver/mock",
        config: { id: "mock-b", script: b },
      },
    ],
  });
  systems.push(result);
  return result;
}

const sendStep = (session: string, message: string) => ({
  tool: "send_session",
  args: { session, message },
});

/**
 * Resolve when a session next reaches a terminal status. `deliver` returns as
 * soon as the woken run *starts*, so anything asserting on what that run did
 * has to wait for it rather than reading the journal straight after.
 */
function whenEnded(ctx: BootResult["ctx"], id: string): Promise<void> {
  return new Promise((resolve) => {
    const off = ctx.on("session/ended", (session: { id: string }) => {
      if (session.id !== id) return;
      off();
      resolve();
    });
  });
}

/** Poll a session's journal until `needle` shows up, or give up. */
async function untilSeen(
  ctx: BootResult["ctx"],
  id: string,
  needle: string,
): Promise<boolean> {
  for (let i = 0; i < 200; i++) {
    const events = ctx.journal.read({ sessionId: id as never, limit: 500 });
    if (JSON.stringify(events).includes(needle)) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return false;
}

function resultOf(events: JournalEvent[], tool: string): any {
  const hit = events.filter(
    (e) => e.type === "tool_result" && (e.payload as any)?.name === tool,
  );
  return (hit.at(-1)?.payload as any)?.result;
}

afterEach(async () => {
  for (const system of systems) {
    await system.app.dispose(system.app.rootFiber).catch(() => undefined);
  }
  systems = [];
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("send_session", () => {
  it("wakes an idle target and does not block the sender", async () => {
    const { ctx } = await bootProject(
      [sendStep("beta", "I took packages/store, do not edit it")],
      [{ turn: "beta working" }],
    );
    const beta = await ctx.sessions.dispatch({
      task: "own the store",
      name: "beta",
      driver: "mock-b",
    });
    await beta.done;
    expect(ctx.sessions.get(beta.record.id)?.status).toBe("completed");

    const alpha = await ctx.sessions.dispatch({
      task: "send a note",
      name: "alpha",
      driver: "mock-a",
    });
    // The sender finishing at all is the assertion: ask_session would have
    // parked here until beta replied.
    const done = await alpha.done;
    expect(done.status).toBe("completed");

    const result = resultOf(
      ctx.journal.read({ sessionId: alpha.record.id, limit: 200 }),
      "send_session",
    );
    expect(result).toMatchObject({ status: "delivered", to: "beta" });
    expect(result.detail).toContain("idle");

    // Beta really took another turn and saw the text.
    const betaEvents = ctx.journal.read({ sessionId: beta.record.id, limit: 200 });
    expect(betaEvents.map((e) => e.type)).toContain("message_received");
    // A woken session receives the message as the *task* of its new turn —
    // it was idle, so there is no in-flight turn to inject into. A mid-turn
    // target gets the same text as an injection instead; both paths are
    // covered below.
    const started = betaEvents.filter((e) => e.type === "session_started").at(-1);
    expect(JSON.stringify(started?.payload ?? {})).toContain("do not edit it");
    expect(JSON.stringify(started?.payload ?? {})).toContain(
      "message from session alpha",
    );
  });

  it("queues into a live run instead of starting a second one", async () => {
    const { ctx } = await bootProject([{ turn: "alpha" }], [{ turn: "beta" }]);
    const beta = await ctx.sessions.dispatch({
      task: "long job",
      name: "beta",
      driver: "mock-b",
    });
    await beta.done;

    // Two deliveries in the same tick: the first wakes, the second must find
    // the run the first started rather than opening a parallel one.
    const ended = whenEnded(ctx, beta.record.id);
    const [first, second] = await Promise.all([
      ctx.sessions.deliver(beta.record.id, "one"),
      ctx.sessions.deliver(beta.record.id, "two"),
    ]);
    expect([first.kind, second.kind].sort()).toEqual(["queued", "woke"]);
    await ended;

    // Neither message may be lost. The queued one rides the first delivery's
    // run if it drains in time, and is redelivered as a fresh wake if that
    // run had already taken its last turn boundary — which is what happens
    // here, because the mock's script contains no awaits.
    expect(await untilSeen(ctx, beta.record.id, "one")).toBe(true);
    expect(await untilSeen(ctx, beta.record.id, "two")).toBe(true);
  });

  it("refuses once the wake budget is spent, and points at post_to_master", async () => {
    const { ctx } = await bootProject([{ turn: "alpha" }], [{ turn: "beta" }]);
    const beta = await ctx.sessions.dispatch({
      task: "quiet one",
      name: "beta",
      driver: "mock-b",
    });
    await beta.done;

    const kinds: string[] = [];
    for (let i = 0; i < 4; i++) {
      const ended = whenEnded(ctx, beta.record.id);
      const outcome = await ctx.sessions.deliver(beta.record.id, `note ${i}`);
      kinds.push(outcome.kind);
      // Each wake has to retire before the next delivery, or the second one
      // would queue into a live run and cost no budget — which is correct
      // behaviour but not what this test is measuring.
      if (outcome.kind === "woke") await ended;
    }
    expect(kinds).toEqual(["woke", "woke", "woke", "refused"]);

    // The user speaking to it refills the budget.
    const revived = await ctx.sessions.continueSession(beta.record.id, "carry on");
    await revived.done;
    expect((await ctx.sessions.deliver(beta.record.id, "again")).kind).toBe(
      "woke",
    );
  });

  it("refuses an unknown name and sending to itself", async () => {
    const { ctx } = await bootProject(
      [sendStep("nobody", "hello"), sendStep("alpha", "hello me")],
      [{ turn: "beta" }],
    );
    const alpha = await ctx.sessions.dispatch({
      task: "send badly",
      name: "alpha",
      driver: "mock-a",
    });
    await alpha.done;

    const events = ctx.journal.read({ sessionId: alpha.record.id, limit: 200 });
    const results = events
      .filter((e) => e.type === "tool_result" && (e.payload as any)?.name === "send_session")
      .map((e) => (e.payload as any).result);
    expect(results[0]).toMatchObject({ status: "refused", reason: "unknown-session" });
    expect(results[1]).toMatchObject({ status: "refused", reason: "self" });
  });

  it("keeps the sibling's text off the master thread", async () => {
    const { ctx } = await bootProject(
      [sendStep("beta", "SECRET-PAYLOAD-9931")],
      [{ turn: "beta" }],
    );
    const beta = await ctx.sessions.dispatch({
      task: "own the store",
      name: "beta",
      driver: "mock-b",
    });
    await beta.done;
    const alpha = await ctx.sessions.dispatch({
      task: "send a note",
      name: "alpha",
      driver: "mock-a",
    });
    await alpha.done;

    const master = ctx.threads.ensureMaster();
    const prose = JSON.stringify(ctx.threads.entries(master.id, { fromSeq: 1 }));
    // Addressed to one session; reprinting it would spend every other
    // sibling's context on a message written for somebody else.
    expect(prose).not.toContain("SECRET-PAYLOAD-9931");
    expect(prose).toContain("received a message from a sibling");
  });
});
