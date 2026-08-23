import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "@daydream-code/kernel";
import { schema, type ProjectStore } from "@daydream-code/store";
import SqliteStore from "@daydream-code/store/sqlite";
import { defaultProjectConfig } from "@daydream-code/shared";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daydream-store-"));
  cleanups.push(() =>
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10 }),
  );
  return dir;
}

async function openStore(rootPath: string) {
  const app = new App();
  const errors: unknown[] = [];
  app.onError = (error) => errors.push(error);
  app.rootCtx.plugin(SqliteStore, { rootPath });
  await app.settle();
  const store = app.rootCtx.get<ProjectStore>("store");
  if (!store) {
    throw new Error(`store failed to load: ${errors.map(String).join("; ")}`);
  }
  cleanups.push(() => app.dispose(app.rootFiber));
  return { app, ctx: app.rootCtx, store };
}

describe("SqliteStore", () => {
  it("opens the database and creates the project row", async () => {
    const root = tempRoot();
    const { store } = await openStore(root);

    expect(store.rootPath).toBe(path.resolve(root));
    expect(store.dataDir).toBe(path.join(path.resolve(root), ".daydream-code"));
    expect(fs.existsSync(path.join(store.dataDir, "store.sqlite"))).toBe(true);

    expect(store.project.id.startsWith("proj_")).toBe(true);
    expect(store.project.name).toBe(path.basename(root));
    expect(store.project.rootPath).toBe(path.resolve(root));
    expect(store.project.config).toEqual(defaultProjectConfig());

    const rows = store.db.select().from(schema.projects).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(store.project.id);
  });

  it("self-writes .gitignore, but leaves an existing one alone", async () => {
    const root = tempRoot();
    const first = await openStore(root);
    const gitignorePath = path.join(first.store.dataDir, ".gitignore");
    expect(fs.readFileSync(gitignorePath, "utf8")).toBe("*.sqlite*\n");
    await first.app.dispose(first.app.rootFiber);

    fs.writeFileSync(gitignorePath, "# custom\n*.sqlite*\n");
    await openStore(root);
    expect(fs.readFileSync(gitignorePath, "utf8")).toBe("# custom\n*.sqlite*\n");
  });

  it("applies the pragmas", async () => {
    const { store } = await openStore(tempRoot());
    expect(store.sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(store.sqlite.pragma("synchronous", { simple: true })).toBe(1); // NORMAL
    expect(store.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(store.sqlite.pragma("busy_timeout", { simple: true })).toBe(5000);
    expect(store.sqlite.pragma("user_version", { simple: true })).toBe(1);
  });

  it("round-trips a drizzle insert+select on every table (DDL matches schema)", async () => {
    const { store } = await openStore(tempRoot());
    const { db } = store;

    const thread = {
      id: "thr_1",
      projectId: store.project.id as string,
      kind: "session" as const,
      forkedFromThread: "thr_0",
      forkedAtSeq: 7,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    db.insert(schema.threads).values(thread).run();
    expect(db.select().from(schema.threads).all()).toEqual([thread]);

    const entry = {
      threadId: "thr_1",
      seq: 1,
      kind: "message" as const,
      sessionId: "sess_1",
      toSessionId: "sess_2",
      supersedesThroughSeq: 0,
      messageJson: JSON.stringify({ role: "user", content: "hi" }),
      tokenEstimate: 5,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    db.insert(schema.threadEntries).values(entry).run();
    expect(db.select().from(schema.threadEntries).all()).toEqual([
      { id: 1, ...entry },
    ]);

    const session = {
      id: "sess_1",
      projectId: store.project.id as string,
      threadId: "thr_1",
      title: "t",
      task: "do things",
      driver: "claude",
      modelId: "claude-fable-5",
      status: "running" as const,
      lastSeenMasterSeq: 3,
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: null,
      summary: null,
      tldr: null,
      tokensIn: 1,
      tokensOut: 2,
      costUsd: 0.5,
    };
    db.insert(schema.sessions).values(session).run();
    expect(db.select().from(schema.sessions).all()).toEqual([session]);

    const event = {
      sessionId: "sess_1",
      ts: "2026-01-01T00:00:00.000Z",
      type: "turn",
      payloadJson: JSON.stringify({ text: "hello" }),
      tokensIn: 10,
      tokensOut: 20,
      costUsd: 0.01,
    };
    db.insert(schema.journalEvents).values(event).run();
    expect(db.select().from(schema.journalEvents).all()).toEqual([
      { id: 1, ...event },
    ]);

    const setting = {
      key: "theme",
      valueJson: JSON.stringify("dark"),
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    db.insert(schema.settings).values(setting).run();
    expect(db.select().from(schema.settings).all()).toEqual([setting]);
  });

  it("reuses the project row on a second open of the same root", async () => {
    const root = tempRoot();
    const first = await openStore(root);
    const projectId = first.store.project.id;
    await first.app.dispose(first.app.rootFiber);

    const second = await openStore(root);
    expect(second.store.project.id).toBe(projectId);
    expect(second.store.db.select().from(schema.projects).all()).toHaveLength(1);
  });
});
