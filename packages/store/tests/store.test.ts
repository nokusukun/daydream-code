import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "@daydream-code/kernel";
import { schema, type ProjectStore } from "@daydream-code/store";
import SqliteStore from "@daydream-code/store/sqlite";
import { migrations, runMigrations } from "@daydream-code/store/migrations";
import Database from "better-sqlite3";
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
    // Pinned to the migration count, not a literal: a hardcoded version here
    // has to be bumped by hand every time one is appended.
    expect(store.sqlite.pragma("user_version", { simple: true })).toBe(
      migrations.length,
    );
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
      name: "do-things",
      title: "do things",
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

describe("migrations", () => {
  /** A database frozen at v1: `title` column, no `name`. */
  function openV1(): InstanceType<typeof Database> {
    const file = path.join(tempRoot(), "v1.sqlite");
    const sqlite = new Database(file);
    cleanups.push(() => sqlite.close());
    const v1 = migrations[0];
    if (typeof v1 !== "string") throw new Error("v1 should be raw SQL");
    sqlite.exec(v1);
    sqlite.pragma("user_version = 1");
    return sqlite;
  }

  function insertV1Session(
    sqlite: InstanceType<typeof Database>,
    id: string,
    projectId: string,
    task: string,
    startedAt: string,
  ): void {
    sqlite
      .prepare(
        `INSERT INTO sessions (id, project_id, thread_id, title, task, driver,
           status, started_at)
         VALUES (?, ?, 'thr_1', NULL, ?, 'mock', 'completed', ?)`,
      )
      .run(id, projectId, task, startedAt);
  }

  /**
   * A database an *earlier* revision of v2 produced: stamped version 2, has
   * `name`, but `title` was dropped. This is the shape that shipped to a real
   * store, and the shape v3 exists to repair.
   */
  function openBrokenV2(): InstanceType<typeof Database> {
    const file = path.join(tempRoot(), "broken-v2.sqlite");
    const sqlite = new Database(file);
    cleanups.push(() => sqlite.close());
    const v1 = migrations[0];
    if (typeof v1 !== "string") throw new Error("v1 should be raw SQL");
    sqlite.exec(v1);
    sqlite.exec(`
      CREATE TABLE sessions_broken (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        name TEXT NOT NULL,
        task TEXT NOT NULL,
        driver TEXT NOT NULL,
        model_id TEXT,
        status TEXT NOT NULL,
        last_seen_master_seq INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        summary TEXT,
        tldr TEXT,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0
      );
      DROP TABLE sessions;
      ALTER TABLE sessions_broken RENAME TO sessions;
    `);
    sqlite.pragma("user_version = 2");
    return sqlite;
  }

  it("repairs a store an earlier v2 left without a title column", () => {
    const sqlite = openBrokenV2();
    sqlite
      .prepare(
        `INSERT INTO sessions (id, project_id, thread_id, name, task, driver,
           status, started_at)
         VALUES (?, 'proj_1', 'thr_1', ?, ?, 'mock', 'completed', '2026-01-01')`,
      )
      .run("ses_a", "hello", "fix the failing tests");

    // The state the app actually hit: the column the code needs is absent.
    expect(
      (sqlite.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[])
        .map((c) => c.name),
    ).not.toContain("title");

    runMigrations(sqlite);

    const row = sqlite
      .prepare(`SELECT name, title FROM sessions WHERE id = 'ses_a'`)
      .get() as { name: string; title: string };
    expect(row).toEqual({ name: "hello", title: "fix the failing tests" });
    expect(sqlite.pragma("user_version", { simple: true })).toBe(
      migrations.length,
    );
  });

  it("leaves a store alone when v2 already produced a title column", () => {
    const sqlite = openV1();
    insertV1Session(sqlite, "ses_a", "proj_1", "fix the failing tests", "2026-01-01");
    runMigrations(sqlite);
    const before = sqlite
      .prepare(`SELECT name, title FROM sessions WHERE id = 'ses_a'`)
      .get();

    // v3 is a no-op here, and re-running everything changes nothing.
    runMigrations(sqlite);
    expect(
      sqlite.prepare(`SELECT name, title FROM sessions WHERE id = 'ses_a'`).get(),
    ).toEqual(before);
    expect(sqlite.pragma("user_version", { simple: true })).toBe(
      migrations.length,
    );
  });

  it("backfills names and titles from task text", () => {
    const sqlite = openV1();
    insertV1Session(sqlite, "ses_a", "proj_1", "fix the failing tests", "2026-01-01");
    insertV1Session(sqlite, "ses_b", "proj_1", "update the docs", "2026-01-02");

    runMigrations(sqlite);

    expect(sqlite.pragma("user_version", { simple: true })).toBe(
      migrations.length,
    );
    const rows = sqlite
      .prepare(`SELECT id, name, title FROM sessions ORDER BY started_at`)
      .all() as { id: string; name: string; title: string }[];
    // `name` is the slugged address; `title` is the readable description.
    expect(rows).toEqual([
      {
        id: "ses_a",
        name: "fix-failing-tests",
        title: "fix the failing tests",
      },
      { id: "ses_b", name: "update-docs", title: "update the docs" },
    ]);

    const columns = (
      sqlite.pragma("table_info(sessions)") as { name: string }[]
    ).map((c) => c.name);
    expect(columns).toContain("name");
    expect(columns).toContain("title");
  });

  it("numbers colliding backfilled names per project, not globally", () => {
    const sqlite = openV1();
    insertV1Session(sqlite, "ses_a", "proj_1", "fix the failing tests", "2026-01-01");
    insertV1Session(sqlite, "ses_b", "proj_1", "fix the failing tests", "2026-01-02");
    // Same task in a different project keeps the unsuffixed name.
    insertV1Session(sqlite, "ses_c", "proj_2", "fix the failing tests", "2026-01-03");

    runMigrations(sqlite);

    const names = Object.fromEntries(
      (
        sqlite.prepare(`SELECT id, name FROM sessions`).all() as {
          id: string;
          name: string;
        }[]
      ).map((r) => [r.id, r.name]),
    );
    expect(names).toEqual({
      ses_a: "fix-failing-tests",
      ses_b: "fix-failing-tests-2",
      ses_c: "fix-failing-tests",
    });
  });

  it("enforces name uniqueness within a project after the rebuild", () => {
    const sqlite = openV1();
    insertV1Session(sqlite, "ses_a", "proj_1", "deploy", "2026-01-01");
    runMigrations(sqlite);

    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO sessions (id, project_id, thread_id, name, title, task,
             driver, status, started_at)
           VALUES ('ses_dup', 'proj_1', 'thr_1', 'deploy', 'deploy', 'deploy',
             'mock', 'completed', '2026-01-02')`,
        )
        .run(),
    ).toThrow(/UNIQUE/i);
  });

  it("is a no-op on an already-current database", () => {
    const sqlite = openV1();
    runMigrations(sqlite);
    const before = sqlite.pragma("user_version", { simple: true });
    runMigrations(sqlite);
    expect(sqlite.pragma("user_version", { simple: true })).toBe(before);
  });
});
