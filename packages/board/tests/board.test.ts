import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { boot, type BootResult } from "@daydream-code/boot";
import { DeferredError, SessionId, ThreadId } from "@daydream-code/shared";
import type { HttpRoutes, RouteRequest } from "@daydream-code/routes";
import { BoardError, type BoardCard } from "@daydream-code/board";
import type {} from "@daydream-code/board";

/**
 * End-to-end for kanban mode through the real composed system: every
 * dispatch becomes a card, an evaluator session clears it, blockers release
 * it, follow-ups re-queue it. Two mock drivers — one for work sessions, one
 * for evaluators — so each side can be scripted on its own.
 *
 * `hang` is a harness tool registered by the test: a session that calls it
 * stays running until the test lets it go, which is how a test holds a card
 * in Working (or an evaluator in Evaluating) for exactly as long as it wants.
 */

let dirs: string[] = [];
let systems: BootResult[] = [];

interface Hang {
  release(): void;
  count(): number;
}

async function bootProject(options: {
  root?: string;
  work: unknown[];
  evaluator: unknown[];
  server?: boolean;
  /** Leave the idle fast-path on (its shipped default) instead of pinning it off. */
  skipWhenIdle?: boolean;
}): Promise<BootResult & { hang: Hang }> {
  const dir = options.root ?? mkdtempSync(join(tmpdir(), "ddc-board-"));
  if (options.root === undefined) dirs.push(dir);
  const result = await boot({
    projectRoot: dir,
    overrides: [
      { id: "driver-claude", disabled: true },
      { id: "driver-mock", disabled: false, config: { id: "mock", script: options.work } },
      {
        id: "driver-mock-eval",
        name: "@daydream-code/driver/mock",
        config: { id: "mock-eval", script: options.evaluator },
      },
      { id: "board", disabled: false },
      {
        id: "board-evaluator",
        disabled: false,
        config: {
          driver: "mock-eval",
          timeoutMs: 60_000,
          // The machinery tests exercise the evaluator itself, and most of
          // their cards start on an idle board — the fast-path would launch
          // them before an evaluator exists. The fast-path tests leave the
          // field unset so they cover the shipped default, not a pin.
          ...(options.skipWhenIdle === true ? {} : { skipWhenIdle: false }),
        },
      },
      { id: "board-writeback", disabled: false },
      { id: "board-routes", disabled: false },
      ...(options.server === true
        ? [{ id: "server", disabled: false, config: { port: 0 } }]
        : []),
    ],
  });
  systems.push(result);

  let waiters: Array<() => void> = [];
  result.ctx.tools.register(result.ctx, {
    name: "hang",
    description: "test only: block until released",
    parameters: { type: "object", properties: {} },
    execute: () =>
      new Promise<unknown>((resolve) => {
        waiters.push(() => resolve({ released: true }));
      }),
  });
  const hang: Hang = {
    release: () => {
      const pending = waiters;
      waiters = [];
      for (const w of pending) w();
    },
    count: () => waiters.length,
  };
  return Object.assign(result, { hang });
}

afterEach(async () => {
  for (const system of systems) {
    // Let every hung run go before unmounting, or the sqlite handle stays
    // open behind a run that never returns and the temp dir cannot be removed.
    (system as { hang?: Hang }).hang?.release();
    await until(system.ctx, "runs to drain", () => system.ctx.sessions.running().length === 0, 2_000).catch(
      () => undefined,
    );
    await system.app.dispose(system.app.rootFiber).catch(() => undefined);
  }
  systems = [];
  for (const dir of dirs) {
    // The evaluator runs `git status` in the project on its way to a prompt;
    // on Windows a directory that is a live process's cwd cannot be removed,
    // and rmSync does not retry that EPERM, so give a just-spawned git time
    // to exit by hand.
    const started = Date.now();
    for (;;) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch (error) {
        if (Date.now() - started > 10_000) throw error;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }
  dirs = [];
});

/** Poll until the predicate holds, or fail with the board as it is. */
async function until(
  ctx: BootResult["ctx"],
  what: string,
  predicate: () => boolean,
  ms = 5_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(
    `timed out waiting for ${what}; board: ${JSON.stringify(
      ctx.board.list().map((c) => ({ id: c.id, column: c.column, title: c.title, reason: c.attentionReason })),
    )}`,
  );
}

async function cardIn(ctx: BootResult["ctx"], id: string, column: BoardCard["column"]): Promise<BoardCard> {
  await until(ctx, `card ${id} in ${column}`, () => ctx.board.get(id)?.column === column);
  return ctx.board.get(id)!;
}

/** Dispatch through the seam and hand back the card it became. */
async function queue(ctx: BootResult["ctx"], task: string): Promise<BoardCard> {
  let deferred: DeferredError | undefined;
  try {
    await ctx.sessions.dispatch({ task, driver: "mock" });
  } catch (error) {
    if (error instanceof DeferredError) deferred = error;
    else throw error;
  }
  expect(deferred, "dispatch in kanban mode must defer").toBeDefined();
  expect(deferred!.kind).toBe("card");
  return ctx.board.get(deferred!.ref)!;
}

/** The evaluator session of a card, once the board has linked it. */
async function evaluatorOf(ctx: BootResult["ctx"], id: string): Promise<SessionId> {
  await until(ctx, `evaluator of ${id}`, () => ctx.board.get(id)?.evaluatorSessionId !== null);
  return ctx.board.get(id)!.evaluatorSessionId!;
}

function masterNotes(ctx: BootResult["ctx"]): string[] {
  const master = ctx.threads.ensureMaster();
  return ctx.threads
    .entries(ThreadId(master.id))
    .filter((e) => e.kind === "note")
    .map((e) => (typeof e.message.content === "string" ? e.message.content : ""));
}

const verdict = (args: Record<string, unknown>) => ({ tool: "board_verdict", args });

describe("kanban mode", () => {
  it("every row mounts and the board is empty", async () => {
    const { app, ctx } = await bootProject({ work: [], evaluator: [] });
    const notActive = app.dumpState().filter((f) => f.state !== "active" && f.name !== "root");
    expect(notActive, JSON.stringify(notActive, null, 2)).toEqual([]);
    expect(ctx.board.list()).toEqual([]);
  });

  it("a dispatch becomes a card, the evaluator clears it, the session runs, the card is done", async () => {
    const { ctx } = await bootProject({
      work: [{ turn: "did the thing" }],
      evaluator: [verdict({ decision: "proceed", reason: "nothing is working" })],
    });
    const card = await queue(ctx, "fix the failing tests");
    expect(["queued", "evaluating"]).toContain(card.column);

    const done = await cardIn(ctx, card.id, "done");
    expect(done.sessionId).not.toBeNull();
    expect(done.verdict?.decision).toBe("proceed");
    const session = ctx.sessions.get(done.sessionId!)!;
    expect(session.status).toBe("completed");
    expect(session.task).toBe("fix the failing tests");
    // The evaluator ran as a real, visible session.
    const evaluator = ctx.sessions.get(done.evaluatorSessionId!)!;
    expect(evaluator.driver).toBe("mock-eval");
    expect(evaluator.task).toMatch(/^\[board evaluation of card /);

    const notes = masterNotes(ctx);
    expect(notes.some((n) => n.includes("queued on the board"))).toBe(true);
    expect(notes.some((n) => n.includes(`started as session ${session.name}`))).toBe(true);
    expect(notes.some((n) => n.includes("done"))).toBe(true);
  });

  it("a card's session and its evaluator are never woken by news of each other's half of the start", async () => {
    // The work session stays live across everything the start writes to the
    // master thread, so any of it that were addressed to it would be drained
    // at its next turn boundary — which is exactly what used to wake a fresh
    // session to read that it had just been started.
    const { ctx, hang } = await bootProject({
      work: [{ tool: "hang" }, { turn: "did the thing" }],
      evaluator: [verdict({ decision: "proceed", reason: "nothing is working" })],
    });
    const card = await queue(ctx, "fix the widths");
    const working = await cardIn(ctx, card.id, "working");
    const worker = working.sessionId!;
    const evaluator = working.evaluatorSessionId!;
    await until(ctx, "worker hanging", () => hang.count() >= 1);
    await until(ctx, "evaluator ended", () => ctx.sessions.get(evaluator)?.status === "completed");
    hang.release();
    await cardIn(ctx, card.id, "done");

    const master = ctx.threads.entries(ThreadId(ctx.threads.ensureMaster().id));
    const started = master.find((e) => e.kind === "note" && String(e.message.content).includes("started as session"));
    expect(started?.causedBy).toEqual(expect.arrayContaining([worker, evaluator]));
    const dispatched = master.find((e) => e.kind === "session_dispatch" && e.sessionId === worker);
    expect(dispatched?.causedBy).toEqual([evaluator]);
    const evaluatorEnded = master.find((e) => e.kind === "session_summary" && e.sessionId === evaluator);
    expect(evaluatorEnded?.causedBy).toEqual([worker]);

    const injected = (id: SessionId) =>
      ctx.journal
        .read({ sessionId: id })
        .filter((e) => e.type === "user_injected")
        .map((e) => JSON.stringify(e.payload));
    expect(injected(worker)).toEqual([]);
    expect(injected(evaluator)).toEqual([]);
  });

  it("a block verdict parks the card until the blocker finishes, then re-evaluates it", async () => {
    const { ctx, hang } = await bootProject({
      work: [{ tool: "hang" }, { turn: "finished" }],
      evaluator: [{ tool: "hang" }],
    });
    const a = await queue(ctx, "add the migration");
    const evalA = await evaluatorOf(ctx, a.id);
    await ctx.board.verdict(a.id, { decision: "proceed", reason: "first in" }, evalA);
    const working = await cardIn(ctx, a.id, "working");
    const sessionA = ctx.sessions.get(working.sessionId!)!;
    await until(ctx, "A hanging", () => hang.count() >= 2); // A's evaluator + A itself

    const b = await queue(ctx, "use the new table");
    const evalB = await evaluatorOf(ctx, b.id);

    // Only Working sessions may block.
    await expect(
      ctx.board.verdict(b.id, { decision: "block", reason: "x", blockedBy: ["nobody"] }, evalB),
    ).rejects.toMatchObject({ code: "bad-blocker" });

    const blocked = await ctx.board.verdict(
      b.id,
      { decision: "block", reason: "needs the migration first", blockedBy: [sessionA.name] },
      evalB,
    );
    expect(blocked.column).toBe("blocked");
    expect(blocked.blockedBy.map((x) => x.blockerName)).toEqual([sessionA.name]);
    expect(masterNotes(ctx).some((n) => n.includes(`blocked by session ${sessionA.name}`))).toBe(true);

    // Let every hung run go: A finishes, and both evaluators end (their
    // verdicts already landed, so that is not a failed evaluation).
    hang.release();
    await cardIn(ctx, a.id, "done");
    // B is released to re-evaluate; a fresh evaluator picks it up.
    const again = await cardIn(ctx, b.id, "evaluating");
    expect(again.blockedBy).toEqual([]);
    await until(ctx, "B's new evaluator", () => {
      const fresh = ctx.board.get(b.id)!;
      return fresh.evaluatorSessionId !== null && fresh.evaluatorSessionId !== evalB;
    });
    expect(masterNotes(ctx).some((n) => n.includes("released"))).toBe(true);
    // The blocker was told which card waited on it.
    const injected = ctx.journal
      .read({ sessionId: sessionA.id, types: ["user_injected"] })
      .map((e) => JSON.stringify(e.payload));
    expect(injected.some((p) => p.includes("[board]") && p.includes(b.title))).toBe(true);
  });

  it("a verdict from anyone but the card's evaluator is refused", async () => {
    const { ctx } = await bootProject({ work: [], evaluator: [{ tool: "hang" }] });
    const a = await queue(ctx, "one");
    const b = await queue(ctx, "two");
    const evalA = await evaluatorOf(ctx, a.id);
    await expect(
      ctx.board.verdict(b.id, { decision: "proceed", reason: "x" }, evalA),
    ).rejects.toBeInstanceOf(BoardError);
    await expect(
      ctx.board.verdict(b.id, { decision: "proceed", reason: "x" }, SessionId("ses_nobody")),
    ).rejects.toMatchObject({ code: "not-evaluator" });
    expect(ctx.board.get(b.id)!.column).toBe("evaluating");
  });

  it("an evaluator that ends without a verdict sends the card to Needs Attention", async () => {
    const { ctx } = await bootProject({ work: [], evaluator: [{ turn: "I have no idea" }] });
    const card = await queue(ctx, "something ambiguous");
    const attention = await cardIn(ctx, card.id, "attention");
    expect(attention.attentionReason).toMatch(/evaluator ended without a verdict/);
    expect(masterNotes(ctx).some((n) => n.includes("needs attention"))).toBe(true);
  });

  it("defer sends a card back behind an Evaluating card ahead of it, and re-enters when that verdict lands", async () => {
    const { ctx } = await bootProject({ work: [{ turn: "ok" }], evaluator: [{ tool: "hang" }] });
    const a = await queue(ctx, "first");
    const b = await queue(ctx, "second");
    const evalA = await evaluatorOf(ctx, a.id);
    const evalB = await evaluatorOf(ctx, b.id);

    // Only ahead in the queue, never behind.
    await expect(
      ctx.board.verdict(a.id, { decision: "defer", reason: "x", deferTo: b.id }, evalA),
    ).rejects.toMatchObject({ code: "bad-defer" });

    const deferred = await ctx.board.verdict(
      b.id,
      { decision: "defer", reason: "looks like the same files", deferTo: a.id },
      evalB,
    );
    expect(deferred.column).toBe("queued");
    // Stays queued while A is still evaluating.
    await new Promise((r) => setTimeout(r, 30));
    expect(ctx.board.get(b.id)!.column).toBe("queued");

    await ctx.board.verdict(a.id, { decision: "proceed", reason: "clear" }, evalA);
    await cardIn(ctx, b.id, "evaluating");
    await until(ctx, "B's second evaluator", () => ctx.board.get(b.id)!.evaluatorSessionId !== evalB);
  });

  it("defer can wait on a Blocked card ahead: held until that card starts, then re-evaluated", async () => {
    const { ctx, hang } = await bootProject({
      work: [{ tool: "hang" }, { turn: "finished" }],
      evaluator: [{ tool: "hang" }],
    });
    const w = await queue(ctx, "rewrite the lane layout");
    await ctx.board.verdict(w.id, { decision: "proceed", reason: "first in" }, await evaluatorOf(ctx, w.id));
    const sessionW = ctx.sessions.get((await cardIn(ctx, w.id, "working")).sessionId!)!;

    const b = await queue(ctx, "newest cards on top");
    await ctx.board.verdict(
      b.id,
      { decision: "block", reason: "same render block", blockedBy: [sessionW.name] },
      await evaluatorOf(ctx, b.id),
    );
    await cardIn(ctx, b.id, "blocked");

    // C conflicts with B, not with anything Working. Before, its only
    // options were to proceed (jumping B) or block on W (wrong reason).
    const c = await queue(ctx, "archive button in the same lane");
    const deferred = await ctx.board.verdict(
      c.id,
      { decision: "defer", reason: "edits the lane B is about to change", deferTo: b.id },
      await evaluatorOf(ctx, c.id),
    );
    expect(deferred.column).toBe("queued");

    // W finishes: B is released and re-evaluated. C still waits: B has not
    // started yet, only moved from Blocked to Evaluating.
    hang.release();
    await cardIn(ctx, w.id, "done");
    const evalB2 = await evaluatorOf(ctx, b.id);
    expect(ctx.board.get(b.id)!.column).toBe("evaluating");
    await new Promise((r) => setTimeout(r, 30));
    expect(ctx.board.get(c.id)!.column).toBe("queued");

    // B starts; C is released to be judged against B running.
    await ctx.board.verdict(b.id, { decision: "proceed", reason: "W is done" }, evalB2);
    await cardIn(ctx, c.id, "evaluating");
  });

  it("a reorder that carries a deferring card past its target ends the wait", async () => {
    const { ctx } = await bootProject({ work: [], evaluator: [{ tool: "hang" }] });
    const a = await queue(ctx, "first");
    const b = await queue(ctx, "second");
    await evaluatorOf(ctx, a.id);
    await ctx.board.verdict(b.id, { decision: "defer", reason: "x", deferTo: a.id }, await evaluatorOf(ctx, b.id));
    expect(ctx.board.get(b.id)!.column).toBe("queued");

    // B now runs first, so waiting on A would mean waiting on a card behind
    // it, which is how two cards end up waiting on each other.
    ctx.board.reorder(b.id, a.id);
    await cardIn(ctx, b.id, "evaluating");
  });

  it("a defer on a card that has since started is refused with that card's session to block on", async () => {
    const { ctx } = await bootProject({ work: [{ tool: "hang" }], evaluator: [{ tool: "hang" }] });
    const a = await queue(ctx, "first");
    const b = await queue(ctx, "second");
    const evalA = await evaluatorOf(ctx, a.id);
    const evalB = await evaluatorOf(ctx, b.id);
    // B's prompt listed A as Evaluating; A launches while B is still reading.
    await ctx.board.verdict(a.id, { decision: "proceed", reason: "clear" }, evalA);
    const sessionA = ctx.sessions.get((await cardIn(ctx, a.id, "working")).sessionId!)!;

    const refusal = await ctx.board
      .verdict(b.id, { decision: "defer", reason: "same files", deferTo: a.id }, evalB)
      .catch((error: unknown) => error);
    expect(refusal).toMatchObject({ code: "bad-defer" });
    expect((refusal as Error).message).toContain(`block on ${sessionA.name}`);
    // The refusal leaves the round open for the verdict it points at.
    const blocked = await ctx.board.verdict(
      b.id,
      { decision: "block", reason: "same files", blockedBy: [sessionA.name] },
      evalB,
    );
    expect(blocked.column).toBe("blocked");
  });

  it("force start skips evaluation and stops the evaluator", async () => {
    const { ctx, hang } = await bootProject({ work: [{ turn: "fast" }], evaluator: [{ tool: "hang" }] });
    const card = await queue(ctx, "urgent");
    const evaluator = await evaluatorOf(ctx, card.id);
    const started = await ctx.board.start(card.id);
    // A scripted run can finish inside `start` itself.
    expect(["working", "done"]).toContain(started.column);
    await cardIn(ctx, card.id, "done");
    // The evaluator was told to stop; once its hung tool returns it is killed,
    // and its end does not touch the card, which has moved on.
    hang.release();
    await until(ctx, "evaluator stopped", () => ctx.sessions.get(evaluator)?.status === "killed");
    expect(ctx.board.get(card.id)!.column).toBe("done");
  });

  it("an idle board skips evaluation: the card starts with no evaluator session at all", async () => {
    const { ctx, hang } = await bootProject({
      work: [{ turn: "fast" }],
      // Any evaluator that did get dispatched would hang, and the card
      // could never reach Done — so Done itself proves the skip.
      evaluator: [{ tool: "hang" }],
      skipWhenIdle: true,
    });
    const card = await queue(ctx, "only card in the building");
    const done = await cardIn(ctx, card.id, "done");
    expect(done.evaluatorSessionId).toBeNull();
    expect(done.verdict).toBeNull();
    expect(hang.count()).toBe(0);
    expect(masterNotes(ctx).some((n) => n.includes("started as session"))).toBe(true);
  });

  it("the skip is only for an idle board: a Working card brings the evaluator back", async () => {
    const { ctx, hang } = await bootProject({
      work: [{ tool: "hang" }, { turn: "released" }],
      evaluator: [verdict({ decision: "proceed", reason: "no overlap" })],
      skipWhenIdle: true,
    });
    const a = await queue(ctx, "long running");
    await cardIn(ctx, a.id, "working");
    expect(ctx.board.get(a.id)!.evaluatorSessionId).toBeNull();
    await until(ctx, "A hanging", () => hang.count() >= 1);

    const b = await queue(ctx, "while A is live");
    const evalB = await evaluatorOf(ctx, b.id);
    expect(ctx.sessions.get(evalB)?.driver).toBe("mock-eval");
    await cardIn(ctx, b.id, "working");
    expect(ctx.board.get(b.id)!.verdict?.decision).toBe("proceed");

    hang.release();
    await cardIn(ctx, a.id, "done");
    await cardIn(ctx, b.id, "done");
  });

  it("two cards entering Evaluating together: the head skips, the second is really evaluated", async () => {
    const { ctx } = await bootProject({
      work: [{ turn: "ok" }],
      evaluator: [verdict({ decision: "proceed", reason: "head start had left evaluating" })],
      skipWhenIdle: true,
    });
    const a = ctx.board.create({ task: "first", request: { driver: "mock" }, draft: true });
    const b = ctx.board.create({ task: "second", request: { driver: "mock" }, draft: true });
    // Back to back, so B enters Evaluating while A's skip-launch is still in
    // flight: A sits in Evaluating ahead of B, and B must fail `foregone` —
    // it could legitimately have deferred to A.
    ctx.board.submit(a.id);
    ctx.board.submit(b.id);

    await cardIn(ctx, a.id, "done");
    await cardIn(ctx, b.id, "done");
    expect(ctx.board.get(a.id)!.evaluatorSessionId).toBeNull();
    expect(ctx.board.get(b.id)!.evaluatorSessionId).not.toBeNull();
    expect(ctx.board.get(b.id)!.verdict?.decision).toBe("proceed");
  });

  it("submitMany queues exactly the drafts it is given, in their order, and skips the rest", async () => {
    const { ctx, hang } = await bootProject({ work: [{ tool: "hang" }], evaluator: [{ tool: "hang" }] });
    const a = ctx.board.create({ task: "first", request: { driver: "mock" }, draft: true });
    const b = ctx.board.create({ task: "second", request: { driver: "mock" }, draft: true });
    const c = ctx.board.create({ task: "third", request: { driver: "mock" }, draft: true });
    const left = ctx.board.create({ task: "not asked for", request: { driver: "mock" }, draft: true });
    const gone = ctx.board.create({ task: "cancelled", request: { driver: "mock" }, draft: true });
    ctx.board.cancel(gone.id);

    // Out of order, with a duplicate, a cancelled card and an unknown id:
    // the caller is queuing what it saw, and those are already dealt with.
    const moved = ctx.board.submitMany([c.id, a.id, gone.id, "card_nope", b.id, a.id]);
    expect(moved.map((card) => card.id)).toEqual([a.id, b.id, c.id]);
    for (const id of [a.id, b.id, c.id]) expect(ctx.board.get(id)!.column).not.toBe("draft");
    expect(ctx.board.get(left.id)!.column).toBe("draft");
    // Positions are kept, so the queue runs them in the order they were written.
    const positions = [a, b, c].map((card) => ctx.board.get(card.id)!.position);
    expect([...positions].sort((x, y) => x - y)).toEqual(positions);
    // Nothing left to move is a no-op, not an error.
    expect(ctx.board.submitMany([a.id, b.id])).toEqual([]);
    hang.release();
  });

  it("a follow-up on a done card re-queues it as new work and the session continues once cleared", async () => {
    const { ctx } = await bootProject({
      work: [{ turn: "round one" }],
      evaluator: [verdict({ decision: "proceed", reason: "clear" })],
    });
    const card = await queue(ctx, "build the widget");
    const done = await cardIn(ctx, card.id, "done");
    const sessionId = done.sessionId!;

    await expect(ctx.sessions.continueSession(sessionId, "now polish it")).rejects.toBeInstanceOf(
      DeferredError,
    );
    const requeued = ctx.board.get(card.id)!;
    expect(["queued", "evaluating"]).toContain(requeued.column);
    expect(requeued.task).toBe("now polish it");
    expect(requeued.sessionId).toBe(sessionId);
    expect(ctx.journal.read({ sessionId, types: ["user_message_deferred"] })).toHaveLength(1);

    const again = await cardIn(ctx, card.id, "done");
    expect(again.sessionId).toBe(sessionId);
    // The same thread ran twice: two session_ended rows on one journal.
    expect(ctx.journal.read({ sessionId, types: ["session_ended"] })).toHaveLength(2);
    expect(masterNotes(ctx).some((n) => n.includes("re-queued with a follow-up"))).toBe(true);
  });

  it("a finished card is unread until someone looks at it, and a follow-up that finishes is unread again", async () => {
    const { ctx } = await bootProject({
      work: [{ turn: "round one" }],
      evaluator: [verdict({ decision: "proceed", reason: "clear" })],
    });
    const card = await queue(ctx, "build the widget");
    const done = await cardIn(ctx, card.id, "done");
    expect(done.seenAt).toBeNull();

    const moved: BoardCard[] = [];
    const seen: BoardCard[] = [];
    ctx.on("board/moved", (c: BoardCard) => moved.push(c));
    ctx.on("board/seen", (c: BoardCard) => seen.push(c));
    const notes = masterNotes(ctx).length;

    const read = ctx.board.markSeen(card.id);
    expect(read.seenAt).not.toBeNull();
    // "finished 2h ago" must not turn into "just now" because someone read it.
    expect(read.updatedAt).toBe(done.updatedAt);
    expect(seen.map((c) => c.id)).toEqual([card.id]);
    // Not a move: the master thread would announce the card as done twice.
    expect(moved).toEqual([]);
    expect(masterNotes(ctx)).toHaveLength(notes);

    // Idempotent: a second report neither restamps nor re-announces.
    expect(ctx.board.markSeen(card.id).seenAt).toBe(read.seenAt);
    expect(seen).toHaveLength(1);

    await expect(ctx.sessions.continueSession(done.sessionId!, "now polish it")).rejects.toBeInstanceOf(
      DeferredError,
    );
    // A report racing the follow-up lands on a card that is no longer Done.
    const requeued = ctx.board.markSeen(card.id);
    expect(requeued.column).not.toBe("done");
    expect(seen).toHaveLength(1);

    const again = await cardIn(ctx, card.id, "done");
    expect(again.seenAt).toBeNull();
  });

  it("a session blocked on a question for the user is Needs Attention until answered", async () => {
    const { ctx } = await bootProject({
      work: [
        {
          tool: "ask_user",
          args: {
            questions: [
              {
                header: "Which",
                question: "which one?",
                options: [
                  { label: "a", description: "the first" },
                  { label: "b", description: "the second" },
                ],
              },
            ],
          },
        },
        { turn: "thanks" },
      ],
      evaluator: [verdict({ decision: "proceed", reason: "clear" })],
    });
    const card = await queue(ctx, "pick one");
    const attention = await cardIn(ctx, card.id, "attention");
    expect(attention.attentionReason).toMatch(/question/);
    expect(ctx.questions.settleCurrent(attention.sessionId!, { kind: "replied", text: "a" })).toBe(true);
    await cardIn(ctx, card.id, "done");
  });

  it("continuing a stopped card's session brings it back from Needs Attention to Working", async () => {
    const { ctx, hang } = await bootProject({
      work: [{ tool: "hang" }, { turn: "picked it back up" }],
      evaluator: [verdict({ decision: "proceed", reason: "clear" })],
    });
    const card = await queue(ctx, "long job");
    const working = await cardIn(ctx, card.id, "working");
    const sessionId = working.sessionId!;
    await until(ctx, "the run to hang", () => hang.count() === 1);
    // `hang` ignores the abort signal, so the stop only lands once it returns.
    const stopped = ctx.sessions.stop(sessionId);
    hang.release();
    await stopped;
    const attention = await cardIn(ctx, card.id, "attention");
    expect(attention.attentionReason).toMatch(/killed/);

    // A revive emits `session/dispatched`, not `session/updated`; the card has
    // to follow it anyway, and while the run is still going.
    await ctx.sessions.continueSession(sessionId, "keep going");
    await until(ctx, "the revived run to hang", () => hang.count() === 1);
    expect(ctx.board.get(card.id)!.column).toBe("working");
    hang.release();
    await cardIn(ctx, card.id, "done");
  });

  it("boot repair finishes a Needs Attention card whose session completed after it got there", async () => {
    const root = mkdtempSync(join(tmpdir(), "ddc-board-stranded-"));
    dirs.push(root);
    const first = await bootProject({
      root,
      work: [{ tool: "hang" }],
      evaluator: [verdict({ decision: "proceed", reason: "clear" })],
    });
    const stranded = await queue(first.ctx, "stranded");
    const failed = await queue(first.ctx, "failed evaluation");
    await until(first.ctx, "both runs to hang", () => first.hang.count() === 2);
    // `release` lets every hung run go, so both stops go out before it.
    const stops = [stranded, failed].map((card) => first.ctx.sessions.stop(first.ctx.board.get(card.id)!.sessionId!));
    first.hang.release();
    await Promise.all(stops);
    await cardIn(first.ctx, stranded.id, "attention");
    await cardIn(first.ctx, failed.id, "attention");
    // What a core without `#onDispatched` left behind: one session revived and
    // completed after its card went to Needs Attention, one that completed
    // before its card got there. Only the first is stranded.
    const at = (card: BoardCard, ms: number) =>
      new Date(Date.parse(first.ctx.board.get(card.id)!.updatedAt) + ms).toISOString();
    const finish = first.ctx.store.sqlite.prepare("UPDATE sessions SET status = 'completed', ended_at = ? WHERE id = ?");
    finish.run(at(stranded, 1_000), first.ctx.board.get(stranded.id)!.sessionId);
    finish.run(at(failed, -1_000), first.ctx.board.get(failed.id)!.sessionId);
    await first.app.dispose(first.app.rootFiber);
    systems = systems.filter((s) => s !== first);

    const second = await bootProject({ root, work: [], evaluator: [] });
    expect(second.ctx.board.get(stranded.id)!.column).toBe("done");
    expect(second.ctx.board.get(failed.id)!.column).toBe("attention");
  });

  it("drafts, edits, submit, reorder and cancel", async () => {
    const { ctx } = await bootProject({ work: [], evaluator: [{ tool: "hang" }] });
    const draft = ctx.board.create({ task: "maybe later", draft: true });
    expect(draft.column).toBe("draft");
    const edited = ctx.board.update(draft.id, { task: "definitely later" });
    expect(edited.title).toBe("definitely later");

    // Reorder happens among cards that have not started: a later draft moved
    // ahead of an earlier one.
    const later = ctx.board.create({ task: "ahead of you", draft: true });
    const moved = ctx.board.reorder(later.id, draft.id);
    expect(moved.position).toBeLessThan(ctx.board.get(draft.id)!.position);
    expect(ctx.board.reorder(later.id, null).position).toBeGreaterThan(ctx.board.get(draft.id)!.position);

    const submitted = ctx.board.submit(draft.id);
    expect(["queued", "evaluating"]).toContain(submitted.column);
    // A card that has started evaluating is what it is.
    await cardIn(ctx, draft.id, "evaluating");
    expect(() => ctx.board.update(draft.id, { task: "changed my mind" })).toThrow(BoardError);
    expect(() => ctx.board.reorder(draft.id, later.id)).toThrow(BoardError);
    expect(() => ctx.board.cancel(draft.id)).toThrow(/evaluating/);

    const stray = ctx.board.create({ task: "never mind", draft: true });
    ctx.board.cancel(stray.id);
    expect(ctx.board.get(stray.id)).toBeUndefined();
  });

  it("a card whose evaluator died with the process is re-queued on the next boot", async () => {
    const root = mkdtempSync(join(tmpdir(), "ddc-board-restart-"));
    dirs.push(root);
    const first = await bootProject({ root, work: [], evaluator: [{ tool: "hang" }] });
    const card = await queue(first.ctx, "survive a restart");
    const evaluator = await evaluatorOf(first.ctx, card.id);
    // Simulate a crash: dispose without letting anything finish.
    await first.app.dispose(first.app.rootFiber);
    systems = systems.filter((s) => s !== first);

    const second = await bootProject({
      root,
      work: [],
      evaluator: [verdict({ decision: "proceed", reason: "clear" })],
    });
    expect(second.ctx.sessions.get(evaluator)?.status).toBe("killed");
    await until(second.ctx, "a fresh evaluation", () => {
      const fresh = second.ctx.board.get(card.id);
      return fresh !== undefined && fresh.evaluatorSessionId !== null && fresh.evaluatorSessionId !== evaluator;
    });
  });

  it("the HTTP surface: board routes, and a deferred dispatch is a 202", async () => {
    const { ctx } = await bootProject({
      work: [{ turn: "ok" }],
      evaluator: [{ tool: "hang" }],
    });
    const routes = ctx.get<HttpRoutes>("routes")!;
    const call = async (method: "GET" | "POST" | "DELETE", path: string, body?: unknown) => {
      const match = routes.match(method, path);
      if (match === undefined) throw new Error(`no route for ${method} ${path}`);
      return match.route.handle({
        method,
        path,
        params: match.params,
        query: {},
        headers: {},
        body,
      } as RouteRequest);
    };

    const created = (await call("POST", "/api/board/cards", { task: "over http", draft: true })) as BoardCard;
    expect(created.column).toBe("draft");
    const board = (await call("GET", "/api/board")) as {
      enabled: boolean;
      cards: BoardCard[];
      display: unknown;
    };
    expect(board.enabled).toBe(true);
    expect(board.cards.map((c) => c.id)).toContain(created.id);
    expect(board.display).toEqual({ unread: "highlight", peekMarksRead: true });
    // Reading a card that has not finished changes nothing.
    const unchanged = (await call("POST", `/api/board/cards/${created.id}/seen`)) as BoardCard;
    expect(unchanged).toMatchObject({ id: created.id, column: "draft", seenAt: null });

    let status: number | undefined;
    let payload: unknown;
    try {
      await call("POST", "/api/sessions", { task: "through the old door" });
    } catch (error) {
      status = (error as { status?: number }).status;
      payload = (error as { body?: unknown }).body;
    }
    expect(status).toBe(202);
    expect(payload).toMatchObject({ deferred: { kind: "card" } });
    const ref = (payload as { deferred: { ref: string } }).deferred.ref;
    expect(ctx.board.get(ref)?.task).toBe("through the old door");

    const removed = (await call("DELETE", `/api/board/cards/${created.id}`)) as BoardCard;
    expect(removed.id).toBe(created.id);
    expect(ctx.board.get(created.id)).toBeUndefined();
  });
});
