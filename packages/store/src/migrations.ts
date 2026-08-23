import type BetterSqlite3 from "better-sqlite3";

/**
 * Hand-written, idempotent DDL matching ./schema.ts exactly. Gated on
 * `PRAGMA user_version`; each entry runs inside one transaction and bumps the
 * version. Never edit a shipped migration — append a new one.
 *
 * The journal is append-only at the storage layer: BEFORE UPDATE / DELETE
 * triggers RAISE(ABORT), so immutability is enforced by SQL, not convention.
 */
const migrations: readonly string[] = [
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
];

/** Bring the database up to the current schema version. Safe to call on every open. */
export function runMigrations(sqlite: BetterSqlite3.Database): void {
  const version = sqlite.pragma("user_version", { simple: true }) as number;
  for (let v = version; v < migrations.length; v++) {
    sqlite.transaction(() => {
      sqlite.exec(migrations[v]!);
      sqlite.pragma(`user_version = ${v + 1}`);
    })();
  }
}
