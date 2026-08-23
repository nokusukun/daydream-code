import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "@daydream-code/kernel";
import { CharEstimator } from "@daydream-code/tokens";
import {
  SessionId,
  ThreadId,
  type ModelMessage,
  type ThreadEntry,
} from "@daydream-code/shared";
import type { CompactionResult } from "@daydream-code/compaction";
import TwoTierCompactor, {
  COMPACTION_HEADER,
} from "@daydream-code/compaction/two-tier";
import { FakeThreads } from "./fake-threads.js";

const msg = (text: string): ModelMessage => ({ role: "user", content: text });

/** Mirror of CharEstimator for string-content messages: ceil(len/4) + 4. */
const est = (text: string) => Math.ceil(text.length / 4) + 4;

const s1 = SessionId("s1");
const s2 = SessionId("s2");

async function setup(config: { budgetTokens: number; keepTokens: number }) {
  const app = new App();
  const errors: unknown[] = [];
  app.onError = (e) => errors.push(e);
  const ctx = app.rootCtx;
  ctx.plugin(FakeThreads);
  ctx.plugin(CharEstimator);
  ctx.plugin(TwoTierCompactor, config);
  await app.settle();
  const threads = ctx.get<FakeThreads>("threads")!;
  const compaction = ctx.get<TwoTierCompactor>("compaction")!;
  const tokens = ctx.get<CharEstimator>("tokens")!;
  expect(threads).toBeDefined();
  expect(compaction).toBeDefined();
  return { app, ctx, threads, compaction, tokens, errors };
}

// Main scenario: session s1 completed (chatter + summary), session s2 still
// running (chatter only), one loose note and one loose message.
const T = {
  note: "Decision: use two-tier compaction for the master thread; keep the tail verbatim.",
  dispatch1: 'new session s1 with msg: "refactor auth token check"',
  turn1a: "session s1 turn end, summary: opened auth.ts and mapped the token flow",
  turn1b: "session s1 turn end, summary: rewrote validateToken in auth.ts",
  summary1:
    "session s1 summary: rewrote validateToken in auth.ts; tests green; no API change",
  dispatch2: 'new session s2 with msg: "add request logging"',
  turn2a: "session s2 turn end, summary: added logger middleware to server.ts",
  tail: "user note: next look at rate limiting",
};

function seedMain(threads: FakeThreads): { threadId: ThreadId; seeded: ThreadEntry[] } {
  const master = threads.ensureMaster();
  const t = master.id;
  const seeded = [
    threads.append({ threadId: t, kind: "note", message: msg(T.note) }),
    threads.append({ threadId: t, kind: "session_dispatch", sessionId: s1, message: msg(T.dispatch1) }),
    threads.append({ threadId: t, kind: "session_turn_end", sessionId: s1, message: msg(T.turn1a) }),
    threads.append({ threadId: t, kind: "session_turn_end", sessionId: s1, message: msg(T.turn1b) }),
    threads.append({ threadId: t, kind: "session_summary", sessionId: s1, message: msg(T.summary1) }),
    threads.append({ threadId: t, kind: "session_dispatch", sessionId: s2, message: msg(T.dispatch2) }),
    threads.append({ threadId: t, kind: "session_turn_end", sessionId: s2, message: msg(T.turn2a) }),
    threads.append({ threadId: t, kind: "message", message: msg(T.tail) }),
  ];
  return { threadId: t, seeded };
}

const mainTotal = Object.values(T).reduce((sum, text) => sum + est(text), 0);
// Cut = entries 1..7: keeping only the tail fits, keeping the tail + turn2a
// does not.
const mainConfig = { budgetTokens: mainTotal - 1, keepTokens: est(T.tail) + 1 };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TwoTierCompactor", () => {
  it("is a no-op when the live context is under budget", async () => {
    const { threads, compaction } = await setup({
      budgetTokens: 10_000,
      keepTokens: 1_000,
    });
    const { threadId } = seedMain(threads);
    const results = await compaction.maybeCompact(threadId);
    expect(results).toEqual([]);
    expect(threads.entries(threadId)).toHaveLength(8);
    expect(threads.entries(threadId).every((e) => e.kind !== "compaction")).toBe(true);
  });

  it("compacts an over-budget thread: correct cut, smaller live window, emitted event", async () => {
    const { ctx, threads, compaction, tokens } = await setup(mainConfig);
    const dones: CompactionResult[] = [];
    ctx.on("compaction/done", (r: CompactionResult) => dones.push(r));
    const { threadId, seeded } = seedMain(threads);

    const before = tokens.estimateEntries(threads.liveContext(threadId));
    const results = await compaction.maybeCompact(threadId);

    expect(results).toHaveLength(1);
    const result = results[0]!;
    expect(result.tier).toBe(2);
    expect(result.threadId).toBe(threadId);
    // Everything except the loose tail message is cut.
    expect(result.supersededThroughSeq).toBe(seeded[6]!.seq);
    expect(result.compactedEntries).toBe(7);
    expect(dones).toEqual([result]);

    const live = threads.liveContext(threadId);
    expect(live.map((e) => e.kind)).toEqual(["message", "compaction"]);
    expect(live[0]!.seq).toBe(seeded[7]!.seq);
    const after = tokens.estimateEntries(live);
    expect(after).toBeLessThan(before);

    const summaryEntry = live[1]!;
    expect(summaryEntry.supersedesThroughSeq).toBe(seeded[6]!.seq);
    const text = summaryEntry.message.content as string;
    expect(text.startsWith(COMPACTION_HEADER)).toBe(true);
    expect(result.summaryChars).toBe(text.length);
  });

  it("keeps session_summary text VERBATIM and drops the session's dispatch/turn_end chatter", async () => {
    const { threads, compaction } = await setup(mainConfig);
    const { threadId } = seedMain(threads);
    await compaction.maybeCompact(threadId);

    const comp = threads.entries(threadId).find((e) => e.kind === "compaction")!;
    const text = comp.message.content as string;
    expect(text).toContain(T.summary1); // verbatim survival
    expect(text).not.toContain(T.dispatch1); // tier-1 collapse
    expect(text).not.toContain(T.turn1a);
    expect(text).not.toContain(T.turn1b);
    // Loose note survives verbatim (short enough to escape truncation).
    expect(text).toContain(T.note);
  });

  it("renders a one-line in-progress marker for sessions whose summary is not live yet", async () => {
    const { threads, compaction } = await setup(mainConfig);
    const { threadId } = seedMain(threads);
    await compaction.maybeCompact(threadId);

    const comp = threads.entries(threadId).find((e) => e.kind === "compaction")!;
    const text = comp.message.content as string;
    expect(text).toContain(`session ${s2} in progress: ${T.turn2a}`);
    // The running session gets exactly one line, not its raw chatter.
    expect(text).not.toContain(T.dispatch2);
  });

  it("never ends the cut between a session's chatter and its live session_summary (extends through it)", async () => {
    const U = {
      note: "note: logging conventions agreed in review",
      dispatch: 'new session s1 with msg: "fix retry loop"',
      turn: "session s1 turn end, summary: patched retry loop in client.ts",
      summary: "session s1 summary: patched retry loop in client.ts; added backoff",
      tail: "user: also check the websocket path",
    };
    const total = Object.values(U).reduce((sum, text) => sum + est(text), 0);
    // Natural cut would stop after `turn` (keeping summary + tail), splitting
    // s1's run from its summary — the compactor must extend through the summary.
    const { threads, compaction } = await setup({
      budgetTokens: total - 1,
      keepTokens: est(U.summary) + est(U.tail) + 1,
    });
    const master = threads.ensureMaster();
    const t = master.id;
    threads.append({ threadId: t, kind: "note", message: msg(U.note) });
    threads.append({ threadId: t, kind: "session_dispatch", sessionId: s1, message: msg(U.dispatch) });
    threads.append({ threadId: t, kind: "session_turn_end", sessionId: s1, message: msg(U.turn) });
    const summaryEntry = threads.append({ threadId: t, kind: "session_summary", sessionId: s1, message: msg(U.summary) });
    const tail = threads.append({ threadId: t, kind: "message", message: msg(U.tail) });

    const results = await compaction.maybeCompact(t);
    expect(results).toHaveLength(1);
    expect(results[0]!.supersededThroughSeq).toBe(summaryEntry.seq);

    const live = threads.liveContext(t);
    expect(live.map((e) => e.seq)).toEqual([tail.seq, tail.seq + 1]);
    const text = live[1]!.message.content as string;
    expect(text).toContain(U.summary); // verbatim
    expect(text).not.toContain(U.turn);
    expect(text).not.toContain("in progress"); // the session is fully covered
  });

  it("compacts again after more appends; the newest compaction wins and prior facts carry forward", async () => {
    const { threads, compaction, tokens } = await setup(mainConfig);
    const { threadId } = seedMain(threads);
    await compaction.maybeCompact(threadId);

    const more = [
      "user note: rate limiting should live in middleware/rate-limit.ts with a sliding window and per-key buckets for the API",
      "user note: remember to wire the compaction budget through project config so per-project overrides keep working end to end",
    ];
    for (const text of more) {
      threads.append({ threadId, kind: "message", message: msg(text) });
    }
    const before = tokens.estimateEntries(threads.liveContext(threadId));
    expect(before).toBeGreaterThan(mainConfig.budgetTokens);

    const results = await compaction.maybeCompact(threadId);
    expect(results).toHaveLength(1);

    const all = threads.entries(threadId);
    const compactions = all.filter((e) => e.kind === "compaction");
    expect(compactions).toHaveLength(2);
    const [first, second] = compactions as [ThreadEntry, ThreadEntry];
    expect(second.supersedesThroughSeq!).toBeGreaterThan(first.supersedesThroughSeq!);
    expect(results[0]!.supersededThroughSeq).toBe(second.supersedesThroughSeq);

    // Newest compaction wins in the folded view.
    const live = threads.liveContext(threadId);
    expect(live.every((e) => e.seq > second.supersedesThroughSeq!)).toBe(true);
    expect(live.some((e) => e.id === second.id)).toBe(true);
    expect(live.some((e) => e.id === first.id)).toBe(false);
    expect(tokens.estimateEntries(live)).toBeLessThan(before);

    // Facts from the first digest carry forward verbatim into the second.
    const text = second.message.content as string;
    expect(text).toContain(T.summary1);
    for (const note of more) expect(text).toContain(note);
    // The old header is stripped rather than nested.
    expect(text.indexOf(COMPACTION_HEADER)).toBe(text.lastIndexOf(COMPACTION_HEADER));
  });

  it("is copy-on-write: raw entries() still returns every superseded row", async () => {
    const { threads, compaction } = await setup(mainConfig);
    const { threadId, seeded } = seedMain(threads);
    await compaction.maybeCompact(threadId);

    const all = threads.entries(threadId);
    expect(all).toHaveLength(9); // 8 seeded + 1 compaction, nothing deleted
    for (const entry of seeded) {
      expect(all.some((e) => e.id === entry.id)).toBe(true);
    }
  });

  it("never cuts fork-parent entries; only own-thread entries are superseded", async () => {
    const { threads, compaction } = await setup({ budgetTokens: 30, keepTokens: 5 });
    const master = threads.ensureMaster();
    const p1 = threads.append({
      threadId: master.id,
      kind: "note",
      message: msg("parent decision: schema is frozen; do not touch migrations"),
    });
    const p2 = threads.append({
      threadId: master.id,
      kind: "note",
      message: msg("parent decision: all writes go through the journal first"),
    });
    const fork = threads.fork(master.id);
    threads.append({ threadId: fork.id, kind: "message", message: msg("session work: step one, read the schema and list tables") });
    threads.append({ threadId: fork.id, kind: "message", message: msg("session work: step two, draft the journal triggers") });
    const last = threads.append({ threadId: fork.id, kind: "message", message: msg("session work: step three, verify with the fake store") });

    const results = await compaction.maybeCompact(fork.id);
    expect(results).toHaveLength(1);
    // The superseded range is inside the fork's own seq space.
    expect(results[0]!.supersededThroughSeq).toBeLessThanOrEqual(last.seq);
    expect(results[0]!.compactedEntries).toBeLessThanOrEqual(3);

    const live = threads.liveContext(fork.id);
    // Parent-chain entries are still live, untouched.
    expect(live.some((e) => e.id === p1.id)).toBe(true);
    expect(live.some((e) => e.id === p2.id)).toBe(true);
    // The compaction entry landed on the fork thread, not the parent.
    expect(threads.entries(master.id).every((e) => e.kind !== "compaction")).toBe(true);
    expect(threads.entries(fork.id).some((e) => e.kind === "compaction")).toBe(true);
  });

  it("never throws: storage failures are logged and swallowed", async () => {
    class ThrowingThreads extends FakeThreads {
      override liveContext(): ThreadEntry[] {
        throw new Error("boom");
      }
    }
    const app = new App();
    const ctx = app.rootCtx;
    ctx.plugin(ThrowingThreads);
    ctx.plugin(CharEstimator);
    ctx.plugin(TwoTierCompactor, { budgetTokens: 10, keepTokens: 5 });
    await app.settle();
    const compaction = ctx.get<TwoTierCompactor>("compaction")!;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(compaction.maybeCompact(ThreadId("t_1"))).resolves.toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
