import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { App, type Context } from "@daydream-code/kernel";
import {
  ProjectId,
  SessionId,
  ThreadId,
  defaultProjectConfig,
  nowIso,
  zeroUsage,
  type JournalEvent,
  type JournalEventInput,
  type ProjectRecord,
  type SessionRecord,
  type Thread,
  type ThreadEntry,
  type ThreadEntryInput,
} from "@daydream-code/shared";
import { ProjectStore } from "@daydream-code/store";
import {
  Journal,
  type JournalReadOptions,
  type JournalSearchHit,
} from "@daydream-code/journal";
import { Threads, type EntryRange } from "@daydream-code/thread";
import {
  Sessions,
  type DispatchRequest,
  type SessionHandle,
} from "@daydream-code/session";
import type { StreamMessage } from "@daydream-code/server";
import FastifyServer, {
  type FastifyServerConfig,
} from "@daydream-code/server/fastify";

// ---------------------------------------------------------------------------
// In-memory fakes for the storage/session seams

const projectId = ProjectId("proj_1");

class FakeStore extends ProjectStore {
  readonly rootPath = "/fake";
  readonly dataDir = "/fake/.daydream-code";
  readonly project: ProjectRecord = {
    id: projectId,
    name: "fake-project",
    rootPath: "/fake",
    config: defaultProjectConfig(),
    createdAt: nowIso(),
  };
  readonly db = undefined as never;
  readonly sqlite = undefined as never;
}

class FakeJournal extends Journal {
  readonly events: JournalEvent[] = [];

  append(input: JournalEventInput): JournalEvent {
    const event: JournalEvent = {
      id: this.events.length + 1,
      ts: input.ts ?? nowIso(),
      sessionId: input.sessionId,
      type: input.type,
      payload: input.payload,
      ...(input.usage !== undefined ? { usage: input.usage } : {}),
    };
    this.events.push(event);
    this.ctx.emit("journal/append", event);
    return event;
  }

  read(options: JournalReadOptions = {}): JournalEvent[] {
    let rows = this.events.filter(
      (e) =>
        (options.sessionId === undefined || e.sessionId === options.sessionId) &&
        (options.afterId === undefined || e.id > options.afterId) &&
        (options.beforeId === undefined || e.id < options.beforeId) &&
        (options.types === undefined || options.types.includes(e.type)),
    );
    if (options.limit !== undefined) {
      rows = options.latest ? rows.slice(-options.limit) : rows.slice(0, options.limit);
    }
    return rows;
  }

  search(
    query: string,
    options: { sessionId?: SessionId; limit?: number } = {},
  ): JournalSearchHit[] {
    return this.events
      .filter(
        (e) =>
          (options.sessionId === undefined || e.sessionId === options.sessionId) &&
          JSON.stringify(e.payload ?? null).includes(query),
      )
      .slice(0, options.limit ?? 20)
      .map((e) => ({
        eventId: e.id,
        sessionId: e.sessionId,
        ts: e.ts,
        type: e.type,
        snippet: JSON.stringify(e.payload ?? null).slice(0, 160),
      }));
  }

  maxId(): number {
    return this.events.length;
  }
}

type SessionIdT = ReturnType<typeof SessionId>;

class FakeThreads extends Threads {
  #threads = new Map<string, Thread>();
  #entries = new Map<string, ThreadEntry[]>();
  #nextId = 1;
  #master: Thread | undefined;

  ensureMaster(): Thread {
    if (this.#master === undefined) {
      this.#master = {
        id: ThreadId("thr_master"),
        projectId,
        kind: "master",
        forkedFromThread: null,
        forkedAtSeq: null,
        createdAt: nowIso(),
      };
      this.#threads.set(this.#master.id, this.#master);
      this.#entries.set(this.#master.id, []);
    }
    return this.#master;
  }

  fork(from: ThreadId, atSeq?: number): Thread {
    const thread: Thread = {
      id: ThreadId(`thr_fork_${this.#threads.size}`),
      projectId,
      kind: "session",
      forkedFromThread: from,
      forkedAtSeq: atSeq ?? this.maxSeq(from),
      createdAt: nowIso(),
    };
    this.#threads.set(thread.id, thread);
    this.#entries.set(thread.id, []);
    return thread;
  }

  get(id: ThreadId): Thread | undefined {
    return this.#threads.get(id);
  }

  append(input: ThreadEntryInput): ThreadEntry {
    const list = this.#entries.get(input.threadId);
    if (list === undefined) throw new Error(`unknown thread: ${input.threadId}`);
    const entry: ThreadEntry = {
      ...input,
      id: this.#nextId++,
      seq: list.length + 1,
      tokenEstimate: input.tokenEstimate ?? 0,
      createdAt: nowIso(),
    };
    list.push(entry);
    this.ctx.emit("thread/append", entry);
    return entry;
  }

  entries(id: ThreadId, range?: EntryRange): ThreadEntry[] {
    let rows = this.#entries.get(id) ?? [];
    if (range?.fromSeq !== undefined) rows = rows.filter((e) => e.seq >= range.fromSeq!);
    if (range?.toSeq !== undefined) rows = rows.filter((e) => e.seq <= range.toSeq!);
    if (range?.limit !== undefined) rows = rows.slice(0, range.limit);
    return rows;
  }

  maxSeq(id: ThreadId): number {
    return this.#entries.get(id)?.length ?? 0;
  }

  liveContext(id: ThreadId): ThreadEntry[] {
    return this.entries(id);
  }
}

function fakeRecord(id: string, task: string): SessionRecord {
  return {
    id: SessionId(id),
    projectId,
    threadId: ThreadId(`thr_${id}`),
    title: null,
    task,
    driver: "mock",
    modelId: null,
    status: "running",
    lastSeenMasterSeq: 0,
    startedAt: nowIso(),
    endedAt: null,
    summary: null,
    tldr: null,
    usage: zeroUsage(),
  };
}

class FakeSessions extends Sessions {
  readonly dispatches: DispatchRequest[] = [];
  readonly continues: Array<{ id: SessionIdT; message: string }> = [];
  readonly stops: SessionIdT[] = [];
  readonly records = new Map<string, SessionRecord>();

  async dispatch(request: DispatchRequest): Promise<SessionHandle> {
    this.dispatches.push(request);
    const record = fakeRecord(`sess_${this.dispatches.length}`, request.task);
    this.records.set(record.id, record);
    return { record, done: Promise.resolve(record) };
  }

  async continueSession(id: SessionIdT, message: string): Promise<SessionHandle> {
    this.continues.push({ id, message });
    const record = this.records.get(id) ?? fakeRecord(id, message);
    this.records.set(record.id, record);
    return { record, done: Promise.resolve(record) };
  }

  async stop(id: SessionIdT): Promise<void> {
    this.stops.push(id);
  }

  get(id: SessionIdT): SessionRecord | undefined {
    return this.records.get(id);
  }

  list(): SessionRecord[] {
    return [...this.records.values()];
  }

  running(): SessionIdT[] {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Harness

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function makeHarness(config: Partial<FastifyServerConfig> = {}) {
  const app = new App();
  const errors: unknown[] = [];
  app.onError = (error) => errors.push(error);
  const ctx = app.rootCtx as Context;
  ctx.plugin(FakeStore);
  ctx.plugin(FakeJournal);
  ctx.plugin(FakeThreads);
  ctx.plugin(FakeSessions);
  const fiber = ctx.plugin(FastifyServer, {
    port: 0,
    ...config,
  } as FastifyServerConfig);
  await app.settle();
  const server = ctx.get<FastifyServer>("server");
  if (server === undefined) {
    throw new Error(`server failed to load: ${errors.map(String).join("; ")}`);
  }
  await server.ready;
  cleanups.push(() => app.dispose(app.rootFiber));
  return {
    app,
    ctx,
    fiber,
    server,
    errors,
    base: server.url,
    journal: ctx.get<FakeJournal>("journal")!,
    threads: ctx.get<FakeThreads>("threads")!,
    sessions: ctx.get<FakeSessions>("sessions")!,
  };
}

function nextFrame(ws: WebSocket): Promise<StreamMessage> {
  return new Promise((resolve, reject) => {
    ws.once("error", reject);
    ws.once("message", (data) => resolve(JSON.parse(String(data)) as StreamMessage));
  });
}

function openStream(url: string): { ws: WebSocket; hello: Promise<StreamMessage> } {
  const ws = new WebSocket(url);
  const hello = nextFrame(ws);
  return { ws, hello };
}

const s1 = SessionId("sess_a");
const s2 = SessionId("sess_b");

// ---------------------------------------------------------------------------

describe("FastifyServer", () => {
  it("serves /health and binds a real port when configured with port 0", async () => {
    const { server, base } = await makeHarness();
    expect(server.port).toBeGreaterThan(0);
    expect(base).toBe(`http://127.0.0.1:${server.port}`);
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("rejects unauthorized requests when a token is configured, accepts bearer/query token", async () => {
    const { base } = await makeHarness({ token: "s3cret" });

    // /health stays open.
    expect((await fetch(`${base}/health`)).status).toBe(200);

    // REST without / with the bearer token.
    const denied = await fetch(`${base}/api/sessions`);
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: "unauthorized" });
    const wrong = await fetch(`${base}/api/sessions`, {
      headers: { authorization: "Bearer nope" },
    });
    expect(wrong.status).toBe(401);
    const allowed = await fetch(`${base}/api/sessions`, {
      headers: { authorization: "Bearer s3cret" },
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual([]);

    // Websocket without ?token= is refused; with it, hello arrives.
    const wsUrl = base.replace("http://", "ws://");
    const refused = new WebSocket(`${wsUrl}/stream`);
    await new Promise<void>((resolve) => {
      refused.once("error", () => resolve());
    });

    const { ws, hello } = openStream(`${wsUrl}/stream?token=s3cret`);
    expect(await hello).toEqual({ kind: "hello", lastEventId: 0 });
    ws.close();
  });

  it("dispatches through the sessions seam and returns the record immediately", async () => {
    const { base, sessions } = await makeHarness();
    const res = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "do the thing", driver: "mock", title: "t" }),
    });
    expect(res.status).toBe(200);
    const record = (await res.json()) as SessionRecord;
    expect(record.task).toBe("do the thing");
    expect(record.status).toBe("running");
    expect(sessions.dispatches).toEqual([
      { task: "do the thing", driver: "mock", title: "t" },
    ]);

    // continue + stop round-trip through the same seam.
    const msg = await fetch(`${base}/api/sessions/${record.id}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "keep going" }),
    });
    expect(msg.status).toBe(200);
    expect(sessions.continues).toEqual([{ id: record.id, message: "keep going" }]);

    const stop = await fetch(`${base}/api/sessions/${record.id}/stop`, {
      method: "POST",
    });
    expect(await stop.json()).toEqual({ stopped: true });
    expect(sessions.stops).toEqual([record.id]);
  });

  it("reads and searches the journal through the REST surface", async () => {
    const { base, journal } = await makeHarness();
    journal.append({ sessionId: s1, type: "turn", payload: { text: "alpha" } });
    journal.append({ sessionId: s2, type: "turn", payload: { text: "beta" } });
    journal.append({ sessionId: s1, type: "tool_call", payload: { text: "gamma" } });

    const res = await fetch(`${base}/api/journal?sessionId=${s1}&afterId=1`);
    const events = (await res.json()) as JournalEvent[];
    expect(events.map((e) => e.id)).toEqual([3]);

    const all = (await (await fetch(`${base}/api/journal`)).json()) as JournalEvent[];
    expect(all.map((e) => e.id)).toEqual([1, 2, 3]);

    const hits = (await (
      await fetch(`${base}/api/journal/search?q=beta`)
    ).json()) as Array<{ eventId: number }>;
    expect(hits.map((h) => h.eventId)).toEqual([2]);
  });

  it("returns a session record with its journal tail, 404 for unknown ids", async () => {
    const { base, journal, sessions } = await makeHarness();
    const record = fakeRecord("sess_x", "task x");
    sessions.records.set(record.id, record);
    journal.append({ sessionId: record.id, type: "turn", payload: 1 });
    journal.append({ sessionId: record.id, type: "turn", payload: 2 });

    const res = await fetch(`${base}/api/sessions/${record.id}?limit=1`);
    const body = (await res.json()) as { session: SessionRecord; journal: JournalEvent[] };
    expect(body.session.id).toBe(record.id);
    expect(body.journal.map((e) => e.id)).toEqual([2]); // latest page

    const missing = await fetch(`${base}/api/sessions/nope`);
    expect(missing.status).toBe(404);
  });

  it("streams hello with the journal cursor, then forwards appended events", async () => {
    const { base, journal } = await makeHarness();
    journal.append({ sessionId: s1, type: "turn", payload: "pre-existing" });

    const wsUrl = `${base.replace("http://", "ws://")}/stream`;
    const { ws, hello } = openStream(wsUrl);
    expect(await hello).toEqual({ kind: "hello", lastEventId: 1 });

    const framePromise = nextFrame(ws);
    const appended = journal.append({ sessionId: s1, type: "turn", payload: "live" });
    const frame = await framePromise;
    expect(frame).toEqual({ kind: "journal", event: appended });
    ws.close();
  });

  it("stops accepting connections after the server fiber is disposed", async () => {
    const { app, fiber, base } = await makeHarness();
    expect((await fetch(`${base}/health`)).status).toBe(200);
    await app.dispose(fiber);
    await expect(fetch(`${base}/health`)).rejects.toThrow();
  });
});
