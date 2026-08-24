import type BetterSqlite3 from "better-sqlite3";
import { slugifyName, titleFromTask, uniqueName } from "@daydream-code/shared";

/**
 * Hand-written, idempotent DDL matching ./schema.ts exactly. Gated on
 * `PRAGMA user_version`; each entry runs inside one transaction and bumps the
 * version. Never edit a shipped migration — append a new one.
 *
 * An entry is either raw SQL or a function, for the rare migration that needs
 * to compute values in JS (backfilling session names from task text).
 *
 * The journal is append-only at the storage layer: BEFORE UPDATE / DELETE
 * triggers RAISE(ABORT), so immutability is enforced by SQL, not convention.
 */
type Migration = string | ((sqlite: BetterSqlite3.Database) => void);

/** Exported for tests that need to stage a database at an older version. */
export const migrations: readonly Migration[] = [
  // v1 — initial schema.
  `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    root_path TEXT NOT NULL,
    config_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    forked_from_thread TEXT,
    forked_at_seq INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS threads_project ON threads (project_id, kind);

  CREATE TABLE IF NOT EXISTS thread_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    session_id TEXT,
    to_session_id TEXT,
    supersedes_through_seq INTEGER,
    message_json TEXT NOT NULL,
    token_estimate INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS thread_entries_thread_seq
    ON thread_entries (thread_id, seq);

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    title TEXT,
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
  CREATE INDEX IF NOT EXISTS sessions_project_started
    ON sessions (project_id, started_at);

  CREATE TABLE IF NOT EXISTS journal_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    tokens_in INTEGER,
    tokens_out INTEGER,
    cost_usd REAL
  );
  CREATE INDEX IF NOT EXISTS journal_events_session
    ON journal_events (session_id, id);
  CREATE INDEX IF NOT EXISTS journal_events_type_ts
    ON journal_events (type, ts);

  CREATE TRIGGER IF NOT EXISTS journal_no_update
  BEFORE UPDATE ON journal_events
  BEGIN
    SELECT RAISE(ABORT, 'journal is append-only');
  END;
  CREATE TRIGGER IF NOT EXISTS journal_no_delete
  BEFORE DELETE ON journal_events
  BEGIN
    SELECT RAISE(ABORT, 'journal is append-only');
  END;

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,

  // v2 — sessions get a human-readable `name` (a stable, unique-per-project
  // address) and a `title` (an evolving one-line description, re-derived
  // whenever the current task changes). Both are backfilled from task text
  // here so they can be NOT NULL.
  (sqlite) => {
    sqlite.exec(`ALTER TABLE sessions ADD COLUMN name TEXT;`);

    const rows = sqlite
      .prepare(
        `SELECT id, project_id, task FROM sessions ORDER BY started_at, rowid`,
      )
      .all() as { id: string; project_id: string; task: string }[];
    const setNaming = sqlite.prepare(
      `UPDATE sessions SET name = ?, title = ? WHERE id = ?`,
    );
    const takenByProject = new Map<string, Set<string>>();
    for (const row of rows) {
      let taken = takenByProject.get(row.project_id);
      if (taken === undefined) {
        taken = new Set<string>();
        takenByProject.set(row.project_id, taken);
      }
      // v1 rows have a `title` column, but nothing ever populated it. Name is
      // the slugged title, matching how dispatch mints the pair.
      const title = titleFromTask(row.task);
      const name = uniqueName(slugifyName(title), (c) => taken!.has(c));
      taken.add(name);
      setNaming.run(name, title, row.id);
    }

    // SQLite cannot add NOT NULL to an existing column or reorder one, so the
    // table is rebuilt now that every row has a name and a title.
    sqlite.exec(`
      CREATE TABLE sessions_v2 (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        name TEXT NOT NULL,
        title TEXT NOT NULL,
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
      INSERT INTO sessions_v2
        SELECT id, project_id, thread_id, name, title, task, driver, model_id, status,
               last_seen_master_seq, started_at, ended_at, summary, tldr,
               tokens_in, tokens_out, cost_usd
        FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_v2 RENAME TO sessions;
      CREATE INDEX IF NOT EXISTS sessions_project_started
        ON sessions (project_id, started_at);
      CREATE UNIQUE INDEX IF NOT EXISTS sessions_project_name
        ON sessions (project_id, name);
    `);
  },

  // v3 — repair stores that an earlier revision of v2 left without `title`.
  //
  // That revision dropped the column instead of keeping it. Databases it
  // already stamped as version 2 never re-run v2, so they are stuck missing a
  // column the code now requires, and every query against `sessions` fails
  // with `no such column: "title"`. Fresh databases take the corrected v2 and
  // arrive here with nothing to do, which is why the migration tests never
  // caught it: they all build up from v0.
  //
  // The lesson is the one at the top of this file. Editing a shipped
  // migration is invisible to anyone who already ran it.
  (sqlite) => {
    const columns = sqlite
      .prepare(`PRAGMA table_info(sessions)`)
      .all() as { name: string }[];
    if (columns.some((c) => c.name === "title")) return;

    sqlite.exec(`ALTER TABLE sessions ADD COLUMN title TEXT;`);

    const rows = sqlite
      .prepare(`SELECT id, task FROM sessions`)
      .all() as { id: string; task: string }[];
    const setTitle = sqlite.prepare(`UPDATE sessions SET title = ? WHERE id = ?`);
    for (const row of rows) setTitle.run(titleFromTask(row.task), row.id);

    // Rebuild to restore the NOT NULL that the corrected v2 gives fresh
    // databases, so both paths end at exactly the same schema.
    sqlite.exec(`
      CREATE TABLE sessions_v3 (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        name TEXT NOT NULL,
        title TEXT NOT NULL,
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
      INSERT INTO sessions_v3
        SELECT id, project_id, thread_id, name, title, task, driver, model_id, status,
               last_seen_master_seq, started_at, ended_at, summary, tldr,
               tokens_in, tokens_out, cost_usd
        FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_v3 RENAME TO sessions;
      CREATE INDEX IF NOT EXISTS sessions_project_started
        ON sessions (project_id, started_at);
      CREATE UNIQUE INDEX IF NOT EXISTS sessions_project_name
        ON sessions (project_id, name);
    `);
  },
];

/** Bring the database up to the current schema version. Safe to call on every open. */
export function runMigrations(sqlite: BetterSqlite3.Database): void {
  const version = sqlite.pragma("user_version", { simple: true }) as number;
  for (let v = version; v < migrations.length; v++) {
    const migration = migrations[v]!;
    sqlite.transaction(() => {
      if (typeof migration === "string") sqlite.exec(migration);
      else migration(sqlite);
      sqlite.pragma(`user_version = ${v + 1}`);
    })();
  }
}
