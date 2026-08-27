import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { App, type Context } from "@daydream-code/kernel";
import { Questions } from "@daydream-code/questions";
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
  type AttachmentInput,
  type DispatchRequest,
  type NextMessage,
  type SessionHandle,
} from "@daydream-code/session";
import { SessionDrivers } from "@daydream-code/driver";
import { HttpRoutes } from "@daydream-code/routes";
import metaRoutes from "@daydream-code/routes/meta";
import storeRoutes from "@daydream-code/store/routes";
import journalRoutes from "@daydream-code/journal/routes";
import threadRoutes from "@daydream-code/thread/routes";
import driverRoutes from "@daydream-code/driver/routes";
import questionRoutes from "@daydream-code/questions/routes";
import sessionRoutes from "@daydream-code/session/routes";
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
    name: "test-session",
    task,
    driver: "mock",
    modelId: null,
    status: "running",
    lastSeenMasterSeq: 0,
    startedAt: nowIso(),
    endedAt: null,
    summary: null,
    tldr: null,
    archivedAt: null,
    usage: zeroUsage(),
  };
}

class FakeSessions extends Sessions {
  readonly dispatches: DispatchRequest[] = [];
  readonly continues: Array<{ id: SessionIdT; message: string }> = [];
  readonly stops: SessionIdT[] = [];
  readonly records = new Map<string, SessionRecord>();
  readonly next = new Map<string, NextMessage[]>();

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

  nextMessages(id: SessionIdT): NextMessage[] {
    return this.next.get(id) ?? [];
  }

  enqueueNextMessage(
    id: SessionIdT,
    message: string,
    _attachments?: AttachmentInput[],
  ): NextMessage {
    const queue = this.next.get(id) ?? [];
    const value: NextMessage = {
      deliveryId: `msg_${queue.length + 1}`,
      message,
      images: [],
      createdAt: nowIso(),
      editing: false,
    };
    queue.push(value);
    this.next.set(id, queue);
    return value;
  }

  beginNextMessageEdit(id: SessionIdT, deliveryId: string): NextMessage {
    const current = this.nextMessages(id).find((item) => item.deliveryId === deliveryId);
    if (current === undefined) throw new Error("queued message is gone");
    Object.assign(current, { editing: true });
    return current;
  }

  updateNextMessage(
    id: SessionIdT,
    deliveryId: string,
    message: string,
    _attachments?: AttachmentInput[],
  ): NextMessage {
    const current = this.beginNextMessageEdit(id, deliveryId);
    Object.assign(current, { message, editing: false });
    return current;
  }

  cancelNextMessageEdit(id: SessionIdT, deliveryId: string): NextMessage {
    const current = this.nextMessages(id).find((item) => item.deliveryId === deliveryId);
    if (current === undefined) throw new Error("queued message is gone");
    Object.assign(current, { editing: false });
    return current;
  }

  cancelNextMessage(id: SessionIdT, deliveryId: string): boolean {
    const queue = this.nextMessages(id);
    const at = queue.findIndex((item) => item.deliveryId === deliveryId);
    if (at < 0) return false;
    queue.splice(at, 1);
    if (queue.length === 0) this.next.delete(id);
    return true;
  }

  async stop(id: SessionIdT): Promise<void> {
    this.stops.push(id);
  }

  /** Set to make the next archive/delete refuse, standing in for a live run. */
  refuse: string | null = null;

  setArchived(id: SessionIdT, archived: boolean): SessionRecord {
    const record = this.records.get(id);
    if (record === undefined) throw new Error(`unknown session: ${id}`);
    if (this.refuse !== null) throw new Error(this.refuse);
    const updated = { ...record, archivedAt: archived ? nowIso() : null };
    this.records.set(id, updated);
    return updated;
  }

  remove(id: SessionIdT): SessionRecord {
    const record = this.records.get(id);
    if (record === undefined) throw new Error(`unknown session: ${id}`);
    this.records.delete(id);
    return record;
  }

  get(id: SessionIdT): SessionRecord | undefined {
    return this.records.get(id);
  }

  resolve(idOrName: string): SessionRecord | undefined {
    return (
      this.records.get(idOrName) ??
      [...this.records.values()].find((r) => r.name === idOrName)
    );
  }

  list(): SessionRecord[] {
    return [...this.records.values()];
  }

  running(): SessionIdT[] {
    return [];
  }
}

class FakeDrivers extends SessionDrivers {
  constructor(ctx: Context) {
    super(ctx);
    this.register(ctx, {
      id: "claude",
      models: [{ id: "m-1", label: "Model One", isDefault: true }],
      run: () => Promise.reject(new Error("not used in server tests")),
    });
    this.register(ctx, {
      id: "mock",
      run: () => Promise.reject(new Error("not used in server tests")),
    });
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
  ctx.plugin(FakeDrivers);
  // The real seam: the answer route settles promises held here, and the
  // service is small enough that faking it would only test the fake.
  ctx.plugin(Questions);
  // The REST surface under test is not the server's own: it lives in each
  // capability package and reaches the transport through the route registry.
  ctx.plugin(HttpRoutes);
  for (const routes of [
    metaRoutes,
    storeRoutes,
    journalRoutes,
    threadRoutes,
    driverRoutes,
    questionRoutes,
    sessionRoutes,
  ]) {
    ctx.plugin(routes);
  }
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

  it("serves the driver model catalog on /api/models", async () => {
    const { base } = await makeHarness();
    const res = await fetch(`${base}/api/models`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      {
        driver: "claude",
        models: [{ id: "m-1", label: "Model One", isDefault: true }],
      },
      { driver: "mock", models: [] },
    ]);
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
      body: JSON.stringify({ task: "do the thing", driver: "mock", name: "t" }),
    });
    expect(res.status).toBe(200);
    const record = (await res.json()) as SessionRecord;
    expect(record.task).toBe("do the thing");
    expect(record.status).toBe("running");
    expect(sessions.dispatches).toEqual([
      { task: "do the thing", driver: "mock", name: "t" },
    ]);

    // continue + stop round-trip through the same seam.
    const msg = await fetch(`${base}/api/sessions/${record.id}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "keep going" }),
    });
    expect(msg.status).toBe(200);
    expect(sessions.continues).toEqual([{ id: record.id, message: "keep going" }]);

    const deferred = await fetch(
      `${base}/api/sessions/${record.id}/next-messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "send this next" }),
      },
    );
    expect(deferred.status).toBe(200);
    const deferredMessage = (await deferred.json()) as NextMessage;
    expect(deferredMessage).toMatchObject({ message: "send this next" });

    const detail = await fetch(`${base}/api/sessions/${record.id}`);
    expect(await detail.json()).toMatchObject({
      nextMessages: [{ message: "send this next", editing: false }],
    });

    const deliveryId = deferredMessage.deliveryId;
    const beginEdit = await fetch(
      `${base}/api/sessions/${record.id}/next-messages/${deliveryId}/edit`,
      { method: "POST" },
    );
    expect(await beginEdit.json()).toMatchObject({ editing: true });

    const update = await fetch(
      `${base}/api/sessions/${record.id}/next-messages/${deliveryId}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "send this edited version" }),
      },
    );
    expect(await update.json()).toMatchObject({
      message: "send this edited version",
      editing: false,
    });

    const cancel = await fetch(
      `${base}/api/sessions/${record.id}/next-messages/${deliveryId}`,
      { method: "DELETE" },
    );
    expect(await cancel.json()).toEqual({ cancelled: true });

    const stop = await fetch(`${base}/api/sessions/${record.id}/stop`, {
      method: "POST",
    });
    expect(await stop.json()).toEqual({ stopped: true });
    expect(sessions.stops).toEqual([record.id]);
  });

  it("archives and deletes a run through the REST surface", async () => {
    const { base, sessions } = await makeHarness();
    const dispatched = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "shelve me" }),
    });
    const record = (await dispatched.json()) as SessionRecord;

    const archived = await fetch(`${base}/api/sessions/${record.id}/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    expect(archived.status).toBe(200);
    expect(((await archived.json()) as SessionRecord).archivedAt).not.toBeNull();

    const restored = await fetch(`${base}/api/sessions/${record.id}/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived: false }),
    });
    expect(((await restored.json()) as SessionRecord).archivedAt).toBeNull();

    const deleted = await fetch(`${base}/api/sessions/${record.id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);
    expect(sessions.get(record.id)).toBeUndefined();

    // Gone means 404 on the next attempt, not a second successful delete.
    const again = await fetch(`${base}/api/sessions/${record.id}`, {
      method: "DELETE",
    });
    expect(again.status).toBe(404);
  });

  /**
   * A seam that refuses becomes a 409, not a 500. The request was well formed;
   * the run was simply busy, and the client's remedy is to stop it and retry.
   */
  it("reports a refused archive as a conflict", async () => {
    const { base, sessions } = await makeHarness();
    const dispatched = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "busy" }),
    });
    const record = (await dispatched.json()) as SessionRecord;
    sessions.refuse = "cannot archive busy while it is running; stop it first";

    const res = await fetch(`${base}/api/sessions/${record.id}/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/stop it first/);
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

    // The type filter is what lets the sidebar ask for assistant prose without
    // dragging down the tool traffic that outnumbers it.
    const turns = (await (
      await fetch(`${base}/api/journal?types=turn&latest=true&limit=10`)
    ).json()) as JournalEvent[];
    expect(turns.map((e) => e.id)).toEqual([1, 2]);

    const both = (await (
      await fetch(`${base}/api/journal?types=turn,tool_call`)
    ).json()) as JournalEvent[];
    expect(both.map((e) => e.id)).toEqual([1, 2, 3]);

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

  it("settles a blocking question through the answer route", async () => {
    const { base, ctx, sessions } = await makeHarness();
    const record = (await sessions.dispatch({ task: "pick one" })).record;
    const question = {
      id: "Which store?",
      header: "Store",
      question: "Which store?",
      options: [
        { label: "sqlite", description: "" },
        { label: "postgres", description: "" },
      ],
      multiSelect: false,
    };
    const asked = ctx.questions.ask(record.id, [question]);

    const res = await fetch(`${base}/api/sessions/${record.id}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers: { "Which store?": "sqlite" } }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ settled: true });
    await expect(asked).resolves.toEqual({
      kind: "answered",
      answers: { "Which store?": "sqlite" },
    });
  });

  it("declines on request, handing the decision back to the model", async () => {
    const { base, ctx, sessions } = await makeHarness();
    const record = (await sessions.dispatch({ task: "pick one" })).record;
    const asked = ctx.questions.ask(record.id, [
      {
        id: "q?",
        header: "H",
        question: "q?",
        options: [
          { label: "a", description: "" },
          { label: "b", description: "" },
        ],
        multiSelect: false,
      },
    ]);
    const res = await fetch(`${base}/api/sessions/${record.id}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decline: true }),
    });
    expect(res.status).toBe(200);
    await expect(asked).resolves.toEqual({ kind: "declined" });
  });

  it("lists pending questions and empties as they settle", async () => {
    const { base, ctx, sessions } = await makeHarness();
    const record = (await sessions.dispatch({ task: "pick one" })).record;
    ctx.questions.ask(record.id, [
      {
        id: "q?",
        header: "H",
        question: "q?",
        options: [
          { label: "a", description: "" },
          { label: "b", description: "" },
        ],
        multiSelect: false,
      },
    ]);
    const listed = (await (await fetch(`${base}/api/questions`)).json()) as unknown[];
    expect(listed).toHaveLength(1);

    ctx.questions.cancelSession(record.id, "test");
    expect(await (await fetch(`${base}/api/questions`)).json()).toEqual([]);
  });

  it("409s a late answer whose request no longer exists", async () => {
    // The shape a restart leaves behind: the promise died with its process, so
    // the client must be told to retire the question rather than keep offering it.
    const { base, sessions } = await makeHarness();
    const record = (await sessions.dispatch({ task: "pick one" })).record;
    const res = await fetch(`${base}/api/sessions/${record.id}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "qst_gone", answers: { "q?": "a" } }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/no pending question/);
  });

  it("rejects an answer that is neither a pick nor a decline", async () => {
    const { base, sessions } = await makeHarness();
    const record = (await sessions.dispatch({ task: "pick one" })).record;
    const res = await fetch(`${base}/api/sessions/${record.id}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers: {} }),
    });
    expect(res.status).toBe(400);
  });

  it("404s an answer for an unknown session", async () => {
    const { base } = await makeHarness();
    const res = await fetch(`${base}/api/sessions/nope/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decline: true }),
    });
    expect(res.status).toBe(404);
  });

  it("serves the routes other packages registered, and 404s the rest", async () => {
    const { base, threads } = await makeHarness();
    const master = threads.ensureMaster();
    threads.append({
      threadId: master.id,
      kind: "note",
      message: { role: "user", content: "hello" },
    });

    const project = (await (await fetch(`${base}/api/project`)).json()) as {
      name: string;
    };
    expect(project.name).toBe("fake-project");

    const entries = (await (await fetch(`${base}/api/master`)).json()) as unknown[];
    expect(entries).toHaveLength(1);

    const fibers = (await (await fetch(`${base}/api/fibers`)).json()) as Array<{
      name: string;
    }>;
    expect(fibers.some((f) => f.name === "HttpRoutes")).toBe(true);

    // Nothing is registered at the root, and the catch-all must not swallow it.
    const root = await fetch(`${base}/`);
    expect(root.status).toBe(404);
    expect(await root.json()).toEqual({ error: "not found: GET /" });
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);

    // HEAD rides on the GET route rather than falling through to the 404.
    expect((await fetch(`${base}/health`, { method: "HEAD" })).status).toBe(200);
  });

  it("leaves OPTIONS to the cors plugin instead of claiming it", async () => {
    // The catch-all deliberately skips OPTIONS: @fastify/cors registers its own
    // preflight route, and two wildcards on one method is a boot-time collision.
    const { base, errors } = await makeHarness();
    const res = await fetch(`${base}/api/sessions`, {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "POST",
      },
    });
    expect(res.status).toBeLessThan(300);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:5173",
    );
    expect(errors).toEqual([]);
  });

  it("serves a route registered after it is already listening, and drops it on unload", async () => {
    // The reason dispatch resolves per request: fastify freezes its router at
    // listen(), but plugins keep loading and unloading for the app's lifetime.
    const { app, ctx, base } = await makeHarness();
    expect((await fetch(`${base}/api/late`)).status).toBe(404);

    const fiber = ctx.plugin({
      name: "late-routes",
      inject: ["routes"],
      apply: (own: Context) =>
        void own.routes.register(own, {
          method: "GET",
          path: "/api/late",
          handle: () => ({ late: true }),
        }),
    });
    await app.settle();
    const res = await fetch(`${base}/api/late`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ late: true });

    await app.dispose(fiber);
    expect((await fetch(`${base}/api/late`)).status).toBe(404);
  });

  it("stops accepting connections after the server fiber is disposed", async () => {
    const { app, fiber, base } = await makeHarness();
    expect((await fetch(`${base}/health`)).status).toBe(200);
    await app.dispose(fiber);
    await expect(fetch(`${base}/health`)).rejects.toThrow();
  });
});
