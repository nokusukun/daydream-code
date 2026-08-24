import { describe, expect, it, vi } from "vitest";
import { App } from "@daydream-code/kernel";
import { SessionId } from "@daydream-code/shared";
import {
  AskRefused,
  SessionAsks,
  type AskOutcome,
  type AskRequest,
  type PendingAsk,
} from "@daydream-code/asks";

const A = SessionId("ses_a");
const B = SessionId("ses_b");
const C = SessionId("ses_c");

function req(from = A, to = B, question = "which one?"): AskRequest {
  const name = (id: string) => id.slice(4);
  return {
    fromSessionId: from,
    fromName: name(from),
    toSessionId: to,
    toName: name(to),
    question,
  };
}

async function harness(config?: Partial<{ nudgeAfterMs: number; maxNudges: number }>) {
  const app = new App();
  const ctx = app.rootCtx;
  const fiber = ctx.plugin(SessionAsks, {
    nudgeAfterMs: 120_000,
    maxNudges: 3,
    ...config,
  });
  await app.settle();
  const requested: PendingAsk[] = [];
  const nudged: Array<[PendingAsk, number]> = [];
  const settled: Array<[PendingAsk, AskOutcome]> = [];
  ctx.on("ask/requested", (p) => requested.push(p));
  ctx.on("ask/nudged", (p, n) => nudged.push([p, n]));
  ctx.on("ask/settled", (p, o) => settled.push([p, o]));
  return { asks: ctx.asks, app, fiber, requested, nudged, settled };
}

/** Let a resolved promise's `.then` run without waiting on real time. */
const tick = () => Promise.resolve();

describe("SessionAsks", () => {
  it("blocks the asker until the target answers", async () => {
    const { asks, requested } = await harness();
    const promise = asks.ask(req());

    let done = false;
    void promise.then(() => (done = true));
    await tick();
    expect(done).toBe(false);
    expect(requested).toHaveLength(1);

    asks.answer(requested[0]!.requestId, B, { kind: "answered", text: "the second one" });
    await expect(promise).resolves.toEqual({ kind: "answered", text: "the second one" });
  });

  it("emits ask/requested only after the waiter is registered", async () => {
    // A listener that answers synchronously — the runner's delivery path can
    // do exactly this — must still find the waiter.
    const app = new App();
    const ctx = app.rootCtx;
    ctx.plugin(SessionAsks, {});
    await app.settle();
    ctx.on("ask/requested", (pending) => {
      ctx.asks.answer(pending.requestId, B, { kind: "answered", text: "instant" });
    });
    await expect(ctx.asks.ask(req())).resolves.toEqual({
      kind: "answered",
      text: "instant",
    });
  });

  it("refuses a session asking itself", async () => {
    const { asks } = await harness();
    expect(() => asks.ask(req(A, A))).toThrow(AskRefused);
    expect(asks.pending()).toHaveLength(0);
  });

  it("refuses a duplicate ask to the same target", async () => {
    const { asks } = await harness();
    void asks.ask(req(A, B, "first"));
    try {
      asks.ask(req(A, B, "second"));
      expect.unreachable("should have refused");
    } catch (error) {
      expect((error as AskRefused).refusal.reason).toBe("duplicate");
    }
  });

  it("refuses a direct cycle instead of parking both sessions", async () => {
    const { asks } = await harness();
    void asks.ask(req(A, B));
    try {
      asks.ask(req(B, A));
      expect.unreachable("should have refused");
    } catch (error) {
      expect((error as AskRefused).refusal.reason).toBe("cycle");
      expect((error as AskRefused).message).toContain("blocked waiting on");
    }
    expect(asks.pending()).toHaveLength(1);
  });

  it("refuses an indirect cycle through a third session", async () => {
    const { asks } = await harness();
    void asks.ask(req(A, B));
    void asks.ask(req(B, C));
    // C -> A would close A -> B -> C -> A.
    try {
      asks.ask(req(C, A));
      expect.unreachable("should have refused");
    } catch (error) {
      expect((error as AskRefused).refusal.reason).toBe("cycle");
    }
    expect(asks.pending()).toHaveLength(2);
  });

  it("only lets the session that was asked answer", async () => {
    const { asks, requested } = await harness();
    const promise = asks.ask(req());
    const id = requested[0]!.requestId;

    expect(asks.answer(id, C, { kind: "answered", text: "not mine to give" })).toBe(
      "not-yours",
    );
    let done = false;
    void promise.then(() => (done = true));
    await tick();
    expect(done).toBe(false);

    expect(asks.answer(id, B, { kind: "answered", text: "mine" })).toBe("settled");
    await expect(promise).resolves.toEqual({ kind: "answered", text: "mine" });
    expect(asks.answer(id, B, { kind: "answered", text: "again" })).toBe("unknown");
  });

  it("nudges up to the cap, then releases the asker as unanswered", async () => {
    const { asks, requested, nudged } = await harness({ maxNudges: 2 });
    const promise = asks.ask(req());
    const id = requested[0]!.requestId;

    expect(asks.nudge(id, "first")).toBe(true);
    expect(asks.nudge(id, "second")).toBe(true);
    expect(nudged.map(([, n]) => n)).toEqual([1, 2]);

    // The third exhausts the budget: the asker is released rather than nudged.
    expect(asks.nudge(id, "gave up")).toBe(false);
    await expect(promise).resolves.toEqual({
      kind: "unanswered",
      reason: "gave up",
      nudges: 2,
    });
  });

  it("nudges on its own timer and gives up without anyone calling it", async () => {
    vi.useFakeTimers();
    try {
      const { asks, nudged } = await harness({ nudgeAfterMs: 1_000, maxNudges: 1 });
      const promise = asks.ask(req());
      let outcome: AskOutcome | undefined;
      void promise.then((o) => (outcome = o));

      await vi.advanceTimersByTimeAsync(1_000);
      expect(nudged).toHaveLength(1);
      expect(outcome).toBeUndefined();

      await vi.advanceTimersByTimeAsync(1_000);
      expect(outcome).toEqual({
        kind: "unanswered",
        reason: "no reply since the last reminder",
        nudges: 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the timer once answered", async () => {
    vi.useFakeTimers();
    try {
      const { asks, requested, nudged } = await harness({ nudgeAfterMs: 1_000 });
      const promise = asks.ask(req());
      asks.answer(requested[0]!.requestId, B, { kind: "answered", text: "here" });
      await promise;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(nudged).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("separates outbound from inbound", async () => {
    const { asks } = await harness();
    void asks.ask(req(A, B));
    void asks.ask(req(C, B));
    expect(asks.outbound(A).map((p) => p.toName)).toEqual(["b"]);
    expect(asks.inbound(B).map((p) => p.fromName)).toEqual(["a", "c"]);
    expect(asks.inbound(A)).toHaveLength(0);
  });

  it("cancels what a departing asker was waiting on, and nothing else", async () => {
    const { asks } = await harness();
    const mine = asks.ask(req(A, B));
    void asks.ask(req(C, A, "owed by A"));

    expect(asks.cancelSession(A, "A ended")).toBe(1);
    await expect(mine).resolves.toEqual({ kind: "cancelled", reason: "A ended" });
    // The question A still owes C survives: A may yet be continued.
    expect(asks.inbound(A)).toHaveLength(1);
  });

  it("releases askers when the target is never coming back", async () => {
    const { asks } = await harness();
    const promise = asks.ask(req(A, B));
    expect(asks.abandonTarget(B, "b was killed")).toBe(1);
    await expect(promise).resolves.toEqual({
      kind: "unanswered",
      reason: "b was killed",
      nudges: 0,
    });
  });

  it("releases every waiter when the service unloads", async () => {
    const { asks, app, fiber } = await harness();
    const promise = asks.ask(req());
    await app.dispose(fiber);
    await expect(promise).resolves.toMatchObject({ kind: "cancelled" });
  });
});
