import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "@daydream-code/kernel";
import {
  type ModelMessage,
  type ThreadEntry,
  type ThreadId,
} from "@daydream-code/shared";
import SqliteStore from "@daydream-code/store/sqlite";
import { CharEstimator } from "@daydream-code/tokens";
import type { Threads } from "@daydream-code/thread";
import ThreadsSqlite from "@daydream-code/thread/sqlite";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function makeThreads() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daydream-thread-"));
  cleanups.push(() =>
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10 }),
  );
  const app = new App();
  const errors: unknown[] = [];
  app.onError = (error) => errors.push(error);
  app.rootCtx.plugin(SqliteStore, { rootPath: dir });
  app.rootCtx.plugin(CharEstimator);
  app.rootCtx.plugin(ThreadsSqlite);
  await app.settle();
  const threads = app.rootCtx.get<Threads>("threads");
  if (!threads) {
    throw new Error(`plugins failed to load: ${errors.map(String).join("; ")}`);
  }
  cleanups.push(() => app.dispose(app.rootFiber));
  return { app, ctx: app.rootCtx, threads };
}

const msg = (text: string): ModelMessage => ({ role: "user", content: text });

function note(threads: Threads, threadId: ThreadId, text: string): ThreadEntry {
  return threads.append({ threadId, kind: "message", message: msg(text) });
}

const texts = (entries: ThreadEntry[]) =>
  entries.map((e) => e.message.content as string);

describe("ThreadsSqlite", () => {
  it("ensureMaster creates the master once and reuses it", async () => {
    const { threads } = await makeThreads();
    const master = threads.ensureMaster();
    expect(master.kind).toBe("master");
    expect(master.id.startsWith("thr_")).toBe(true);
    expect(master.forkedFromThread).toBeNull();
    expect(threads.ensureMaster().id).toBe(master.id);
    expect(threads.get(master.id)?.id).toBe(master.id);
  });

  it("assigns monotonic per-thread seqs and token estimates", async () => {
    const { threads } = await makeThreads();
    const master = threads.ensureMaster();
    const e1 = note(threads, master.id, "one");
    const e2 = note(threads, master.id, "two");
    expect([e1.seq, e2.seq]).toEqual([1, 2]);
    expect(e1.tokenEstimate).toBeGreaterThan(0); // estimator fallback

    const fork = threads.fork(master.id);
    const f1 = note(threads, fork.id, "fork-one");
    expect(f1.seq).toBe(1); // seq is per-thread

    const e3 = threads.append({
      threadId: master.id,
      kind: "message",
      message: msg("three"),
      tokenEstimate: 123,
    });
    expect(e3.seq).toBe(3);
    expect(e3.tokenEstimate).toBe(123); // explicit estimate wins
    expect(threads.maxSeq(master.id)).toBe(3);
    expect(threads.entries(master.id).map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("fork defaults to the parent's maxSeq and records the fork point", async () => {
    const { threads } = await makeThreads();
    const master = threads.ensureMaster();
    note(threads, master.id, "a");
    note(threads, master.id, "b");

    const fork = threads.fork(master.id);
    expect(fork.kind).toBe("session");
    expect(fork.forkedFromThread).toBe(master.id);
    expect(fork.forkedAtSeq).toBe(2);

    const early = threads.fork(master.id, 1);
    expect(early.forkedAtSeq).toBe(1);
  });

  it("liveContext resolves the fork chain and hides post-fork parent entries", async () => {
    const { threads } = await makeThreads();
    const master = threads.ensureMaster();
    note(threads, master.id, "m1");
    note(threads, master.id, "m2");

    const fork = threads.fork(master.id);
    note(threads, master.id, "m3-after-fork");
    note(threads, fork.id, "f1");

    expect(texts(threads.liveContext(fork.id))).toEqual(["m1", "m2", "f1"]);
    expect(texts(threads.liveContext(master.id))).toEqual(["m1", "m2", "m3-after-fork"]);

    // Two levels deep: a fork of the fork resolves the whole chain.
    const grandchild = threads.fork(fork.id);
    note(threads, fork.id, "f2-after-grandfork");
    note(threads, grandchild.id, "g1");
    expect(texts(threads.liveContext(grandchild.id))).toEqual(["m1", "m2", "f1", "g1"]);

    expect(threads.liveMessages(fork.id).map((m) => m.content)).toEqual([
      "m1",
      "m2",
      "f1",
      "f2-after-grandfork",
    ]);
  });

  it("folds compaction: newest cut replaces what it supersedes", async () => {
    const { threads } = await makeThreads();
    const master = threads.ensureMaster();
    for (const text of ["e1", "e2", "e3", "e4", "e5"]) note(threads, master.id, text);

    threads.append({
      threadId: master.id,
      kind: "compaction",
      message: msg("summary-of-1-3"),
      supersedesThroughSeq: 3,
    });

    expect(texts(threads.liveContext(master.id))).toEqual([
      "summary-of-1-3",
      "e4",
      "e5",
    ]);
    // Copy-on-write: the raw entries are all still there.
    expect(threads.entries(master.id)).toHaveLength(6);

    // A newer cut wins over the older one.
    threads.append({
      threadId: master.id,
      kind: "compaction",
      message: msg("summary-of-1-5"),
      supersedesThroughSeq: 5,
    });
    expect(texts(threads.liveContext(master.id))).toEqual(["summary-of-1-5"]);
  });

  it("a fork below a later compaction cut still sees the original entries", async () => {
    const { threads } = await makeThreads();
    const master = threads.ensureMaster();
    for (const text of ["e1", "e2", "e3", "e4"]) note(threads, master.id, text);

    const fork = threads.fork(master.id, 2);
    const before = texts(threads.liveContext(fork.id));
    expect(before).toEqual(["e1", "e2"]);

    threads.append({
      threadId: master.id,
      kind: "compaction",
      message: msg("summary-of-1-4"),
      supersedesThroughSeq: 4,
    });

    expect(texts(threads.liveContext(fork.id))).toEqual(before); // unchanged
    expect(texts(threads.liveContext(master.id))).toEqual(["summary-of-1-4"]);
  });

  it("emits thread/append after a durable append", async () => {
    const { ctx, threads } = await makeThreads();
    const master = threads.ensureMaster();
    const seen: ThreadEntry[] = [];
    ctx.on("thread/append", (entry: ThreadEntry) => {
      // Durable by the time listeners run.
      expect(threads.entries(master.id, { fromSeq: entry.seq }).length).toBe(1);
      seen.push(entry);
    });
    const entry = note(threads, master.id, "hello");
    expect(seen).toEqual([entry]);
  });

  it("respects entry ranges (fromSeq/toSeq/limit)", async () => {
    const { threads } = await makeThreads();
    const master = threads.ensureMaster();
    for (const text of ["e1", "e2", "e3", "e4"]) note(threads, master.id, text);

    expect(texts(threads.entries(master.id, { fromSeq: 2, toSeq: 3 }))).toEqual([
      "e2",
      "e3",
    ]);
    expect(texts(threads.entries(master.id, { limit: 2 }))).toEqual(["e1", "e2"]);
  });
});
