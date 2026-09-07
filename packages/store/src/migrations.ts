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

  // v4 — archiving, and the narrow exemption that lets a run be deleted.
  //
  // `archived_at` is a shelf: a finished run the person is done looking at
  // leaves the rail without leaving the project. Nullable, so every existing
  // row backfills to "not archived" without a rebuild.
  //
  // The trigger change is the part worth reading. `journal_no_delete` used to
  // abort unconditionally, which made "delete this run" unimplementable at the
  // storage layer — and a Delete that could only unlink the `sessions` row
  // would leave the transcript in `journal.search` and break `read_session`,
  // so the harness would keep serving a run the person had deleted.
  //
  // What the append-only rule protects is history being *rewritten* underneath
  // a reader: an event edited, or a prefix trimmed, while something downstream
  // still points at it. Reaping the events of a session that no longer exists
  // is a different act. So immutability is now scoped to exactly that claim —
  // a journal row is untouchable for as long as its session row exists — and a
  // purge deletes the `sessions` row first, inside one transaction. UPDATE
  // stays absolutely forbidden: there is no such thing as a legitimate edit.
  `
  ALTER TABLE sessions ADD COLUMN archived_at TEXT;
  CREATE INDEX IF NOT EXISTS sessions_project_archived
    ON sessions (project_id, archived_at);

  DROP TRIGGER IF EXISTS journal_no_delete;
  CREATE TRIGGER journal_no_delete
  BEFORE DELETE ON journal_events
  WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
  BEGIN
    SELECT RAISE(ABORT, 'journal is append-only');
  END;
  `,

  // v5 — quick actions: the named shell lines the desktop toolbar runs at the
  // project root.
  //
  // These started in the renderer's localStorage, which was right while a
  // person was the only author. A session is one now — the agent can offer
  // "run the dev server" as a row you click rather than a command you copy —
  // and a harness tool runs in the core, which has no window and no
  // localStorage to write to. Shared authorship is what moves them into the
  // store.
  //
  // Per project, because that is the scope the table has: an action worth
  // saving names this repo's dev server, not every repo's. `source` records
  // who added it, so a row the agent wrote can say so rather than appearing in
  // the person's own list indistinguishable from one they typed. The unique
  // index makes "add the same command twice" a no-op at the storage layer
  // instead of a rule each caller remembers.
  `
  CREATE TABLE IF NOT EXISTS quick_actions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    label TEXT NOT NULL,
    command TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS quick_actions_project
    ON quick_actions (project_id, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS quick_actions_project_command
    ON quick_actions (project_id, command);
  `,

  // v6 — reasoning effort, pinned per session the way model_id is. Nullable
  // TEXT rather than an enum CHECK: the valid level set belongs to whichever
  // driver dispatched the session ("xhigh" is Claude's, "minimal" is Codex's),
  // and a constraint baked into shipped DDL would outlive both catalogs.
  `
  ALTER TABLE sessions ADD COLUMN effort TEXT;
  `,

  // v7 — provider fast mode is a durable per-thread choice. SQLite stores
  // booleans as 0/1; the default keeps every existing session on standard
  // speed until the person explicitly opts in.
  `
  ALTER TABLE sessions ADD COLUMN fast_mode INTEGER NOT NULL DEFAULT 0;
  `,
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
