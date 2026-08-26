import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "@daydream-code/kernel";
import { SessionId, type JournalEvent } from "@daydream-code/shared";
import { schema, type ProjectStore } from "@daydream-code/store";
import SqliteStore from "@daydream-code/store/sqlite";
import type { Journal } from "@daydream-code/journal";
import JournalSqlite from "@daydream-code/journal/sqlite";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function makeJournal() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daydream-journal-"));
  cleanups.push(() =>
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10 }),
  );
  const app = new App();
  const errors: unknown[] = [];
  app.onError = (error) => errors.push(error);
  app.rootCtx.plugin(SqliteStore, { rootPath: dir });
  app.rootCtx.plugin(JournalSqlite);
  await app.settle();
  const journal = app.rootCtx.get<Journal>("journal");
  const store = app.rootCtx.get<ProjectStore>("store");
  if (!journal || !store) {
    throw new Error(`plugins failed to load: ${errors.map(String).join("; ")}`);
  }
  cleanups.push(() => app.dispose(app.rootFiber));
  return { app, ctx: app.rootCtx, journal, store };
}

const s1 = SessionId("sess_1");
const s2 = SessionId("sess_2");

describe("JournalSqlite", () => {
  it("append assigns id and ts and persists the payload", async () => {
    const { journal } = await makeJournal();
    const before = Date.now();
    const event = journal.append({
      sessionId: s1,
      type: "turn",
      payload: { text: "hello" },
    });
    expect(event.id).toBe(1);
    expect(Date.parse(event.ts)).toBeGreaterThanOrEqual(before - 1);
    expect(event.payload).toEqual({ text: "hello" });

    const next = journal.append({ sessionId: s1, type: "turn", payload: 2 });
    expect(next.id).toBe(2);

    const read = journal.read();
    expect(read.map((e) => e.id)).toEqual([1, 2]);
    expect(read[0]!.payload).toEqual({ text: "hello" });
  });

  it("emits journal/append after the row is durably committed", async () => {
    const { ctx, journal, store } = await makeJournal();
    const seen: Array<{ event: JournalEvent; durable: boolean }> = [];
    ctx.on("journal/append", (event: JournalEvent) => {
      const row = store.db
        .select()
        .from(schema.journalEvents)
        .where(eq(schema.journalEvents.id, event.id))
        .get();
      seen.push({ event, durable: row !== undefined });
    });

    const event = journal.append({
      sessionId: s1,
      type: "tool_call",
      payload: { toolName: "read" },
      usage: { tokensIn: 3 },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.durable).toBe(true);
    expect(seen[0]!.event).toEqual(event);
    expect(event.usage).toEqual({ tokensIn: 3 });
  });

  it("rejects UPDATE and DELETE via the append-only triggers", async () => {
    const { journal, store } = await makeJournal();
    journal.append({ sessionId: s1, type: "turn", payload: "x" });
    // The DELETE trigger is scoped to events whose session still exists, so
    // the session row has to be here for this to test anything. Every event a
    // real run writes has one; the only rows without are orphans left by a
    // purge, which is the case migration v4 deliberately allows.
    store.sqlite
      .prepare(
        `INSERT INTO sessions (id, project_id, thread_id, name, title, task,
           driver, status, started_at)
         VALUES (?, 'proj_1', 'thr_1', 'run-a', 'Run A', 'run a', 'mock',
           'running', '2026-01-01')`,
      )
      .run(s1);

    expect(() =>
      store.sqlite.prepare("UPDATE journal_events SET type = 'edited'").run(),
    ).toThrow(/append-only/);
    expect(() =>
      store.sqlite.prepare("DELETE FROM journal_events").run(),
    ).toThrow(/append-only/);
    expect(journal.maxId()).toBe(1);
  });

  it("read supports sessionId, afterId, types, limit, and latest", async () => {
    const { journal } = await makeJournal();
    journal.append({ sessionId: s1, type: "session_started", payload: 1 }); // id 1
    journal.append({ sessionId: s1, type: "turn", payload: 2 }); // id 2
    journal.append({ sessionId: s2, type: "turn", payload: 3 }); // id 3
    journal.append({ sessionId: s1, type: "tool_call", payload: 4 }); // id 4
    journal.append({ sessionId: s1, type: "turn", payload: 5 }); // id 5

    expect(journal.read({ sessionId: s2 }).map((e) => e.id)).toEqual([3]);
    expect(journal.read({ afterId: 3 }).map((e) => e.id)).toEqual([4, 5]);
    expect(journal.read({ beforeId: 3 }).map((e) => e.id)).toEqual([1, 2]);
    expect(
      journal.read({ types: ["turn", "tool_call"], sessionId: s1 }).map((e) => e.id),
    ).toEqual([2, 4, 5]);
    expect(journal.read({ limit: 2 }).map((e) => e.id)).toEqual([1, 2]);
    // latest: newest `limit` rows, still ascending.
    expect(journal.read({ latest: true, limit: 2 }).map((e) => e.id)).toEqual([4, 5]);
    expect(journal.maxId()).toBe(5);
  });

  it("search finds a snippet around the hit and escapes LIKE wildcards", async () => {
    const { journal } = await makeJournal();
    const padding = "x".repeat(200);
    journal.append({
      sessionId: s1,
      type: "tool_result",
      payload: { text: `${padding} the secret needle sits here ${padding}` },
    });
    journal.append({ sessionId: s2, type: "turn", payload: "nothing to see" });
    journal.append({ sessionId: s1, type: "turn", payload: "progress: 100x done" });
    journal.append({ sessionId: s1, type: "turn", payload: "progress: 100% done" });

    const hits = journal.search("secret needle");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.eventId).toBe(1);
    expect(hits[0]!.sessionId).toBe(s1);
    expect(hits[0]!.type).toBe("tool_result");
    expect(hits[0]!.snippet).toContain("secret needle");
    expect(hits[0]!.snippet.length).toBeLessThanOrEqual("secret needle".length + 160);

    // % must match literally, not as a wildcard.
    const percent = journal.search("100%");
    expect(percent.map((h) => h.eventId)).toEqual([4]);

    // sessionId narrows the search.
    expect(journal.search("nothing", { sessionId: s1 })).toHaveLength(0);
    expect(journal.search("nothing", { sessionId: s2 })).toHaveLength(1);
  });

  it("excludeTail hides one session's tail without touching the others", async () => {
    const { journal } = await makeJournal();
    const a1 = journal.append({ sessionId: s1, type: "turn", payload: "needle one" });
    const b1 = journal.append({ sessionId: s2, type: "turn", payload: "needle two" });
    const a2 = journal.append({ sessionId: s1, type: "turn", payload: "needle three" });
    const b2 = journal.append({ sessionId: s2, type: "turn", payload: "needle four" });

    // Everything from s1 at or after a2 is dropped; s2 is untouched even
    // though b2 was appended after the cutoff. A global `beforeId` would have
    // taken b2 with it, which is the whole reason this option is scoped.
    const hits = journal.search("needle", {
      excludeTail: { sessionId: s1, fromId: a2.id },
    });
    expect(hits.map((h) => h.eventId)).toEqual([a1.id, b1.id, b2.id]);

    // Combined with sessionId it degrades to a plain cutoff on that session.
    const own = journal.search("needle", {
      sessionId: s1,
      excludeTail: { sessionId: s1, fromId: a2.id },
    });
    expect(own.map((h) => h.eventId)).toEqual([a1.id]);
  });
});
