import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "@daydream-code/kernel";
import {
  SessionId,
  ThreadId,
  type SessionRecord,
  type ThreadEntryInput,
} from "@daydream-code/shared";
import SqliteStore from "@daydream-code/store/sqlite";
import { CharEstimator } from "@daydream-code/tokens";
import type { Threads } from "@daydream-code/thread";
import ThreadsSqlite from "@daydream-code/thread/sqlite";
import masterInject from "@daydream-code/thread/master-inject";
import type {} from "@daydream-code/session";

/**
 * Echo suppression at the delivery seam: an automatic entry that records a
 * session in `causedBy` never reaches that session, and what does reach it is
 * reported back as the causes of the turn it wakes.
 */

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function mount() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daydream-inject-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10 }));
  const app = new App();
  const errors: unknown[] = [];
  app.onError = (error) => errors.push(error);
  app.rootCtx.plugin(SqliteStore, { rootPath: dir });
  app.rootCtx.plugin(CharEstimator);
  app.rootCtx.plugin(ThreadsSqlite);
  app.rootCtx.plugin(masterInject);
  await app.settle();
  expect(errors).toEqual([]);
  cleanups.push(() => app.dispose(app.rootFiber));
  const ctx = app.rootCtx;
  const threads = ctx.get<Threads>("threads")!;
  const master = ThreadId(threads.ensureMaster().id);
  return { ctx, threads, master };
}

const A = SessionId("ses_a");
const B = SessionId("ses_b");
const READER = SessionId("ses_reader");

function reader(): SessionRecord {
  // Only the fields master-inject reads; the cursor starts before everything.
  return { id: READER, lastSeenMasterSeq: 0 } as SessionRecord;
}

function collect(ctx: App["rootCtx"], session = reader(), withInput = true) {
  const blocks: string[] = [];
  const causes = new Set<SessionId>();
  ctx.emit("session/collect-injections", session, blocks, causes, withInput);
  return { text: blocks.join("\n"), causes };
}

function entry(
  master: ThreadId,
  kind: ThreadEntryInput["kind"],
  content: string,
  extra: Partial<ThreadEntryInput> = {},
): ThreadEntryInput {
  return { threadId: master, kind, message: { role: "user", content }, ...extra };
}

describe("master-inject echo suppression", () => {
  it("round-trips causedBy, and leaves it off entries that have none", async () => {
    const { threads, master } = await mount();
    const echoed = threads.append(entry(master, "note", "x", { causedBy: [A, B, A] }));
    const plain = threads.append(entry(master, "note", "y"));
    const [first, second] = threads.entries(master);
    expect(first!.causedBy).toEqual([A, B]); // de-duplicated on the way in
    expect(echoed.causedBy).toEqual([A, B]);
    expect(second!.causedBy).toBeUndefined();
    expect(plain.causedBy).toBeUndefined();
  });

  it("never hands a session an entry that echoes it", async () => {
    const { ctx, threads, master } = await mount();
    threads.append(entry(master, "note", "card started as session reader", { causedBy: [READER] }));
    threads.append(
      entry(master, "session_turn_end", "session a turn end, summary: nothing for me", {
        sessionId: A,
        causedBy: [READER],
      }),
    );
    threads.append(entry(master, "note", "card queued on the board"));

    const { text, causes } = collect(ctx);
    expect(text).toContain("card queued on the board");
    // Positive control above, so these absences mean filtered, not unrendered.
    expect(text).not.toContain("card started as session reader");
    expect(text).not.toContain("turn end");
    expect([...causes]).toEqual([]);
  });

  it("reports the delivered entries' authors and their own causes, transitively", async () => {
    const { ctx, threads, master } = await mount();
    threads.append(
      entry(master, "session_turn_end", "session b turn end, summary: s", {
        sessionId: B,
        causedBy: [A],
      }),
    );
    const { text, causes } = collect(ctx);
    expect(text).toContain("turn end");
    expect([...causes].sort()).toEqual([A, B].sort());
  });

  it("a deliberate message is delivered and is not a cause: a reply to it must get through", async () => {
    const { ctx, threads, master } = await mount();
    threads.append(entry(master, "session_message", "message from session a: heads up", { sessionId: A }));
    const { text, causes } = collect(ctx);
    expect(text).toContain("heads up");
    expect([...causes]).toEqual([]);
  });
});

describe("master-inject never wakes a session on its own", () => {
  it("holds the backlog when no turn is starting, and delivers it with the next one", async () => {
    const { ctx, threads, master } = await mount();
    threads.append(
      entry(master, "session_turn_end", "session a turn end, summary: s", { sessionId: A }),
    );
    const session = reader();

    const idle = collect(ctx, session, false);
    expect(idle.text).toBe("");
    expect([...idle.causes]).toEqual([]);
    // Not stepped over: the cursor stays put so nothing is lost.
    expect(session.lastSeenMasterSeq).toBe(0);

    const next = collect(ctx, session, true);
    expect(next.text).toContain("session ses_a turn end");
    expect(session.lastSeenMasterSeq).toBeGreaterThan(0);
  });
});
