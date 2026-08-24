/**
 * Per-project facts for the switcher, read straight from each project's store.
 *
 * The registry knows only name, path, and lastOpenedAt, which makes a project
 * row a folder name the user already knows. The interesting facts live in
 * `<root>/.daydream-code/store.sqlite`, so this opens each one read-only and
 * asks it two questions.
 *
 * One rule governs what comes back: **a closed project may not report live
 * state.** Boot repair (`session/runner.ts`) only runs when a project's core
 * starts, so a project nobody has opened since a crash can hold sessions still
 * marked `running` forever. Counting them would put a number on screen that is
 * false and unfalsifiable. `live` is therefore `null` for every project except
 * the one whose core is actually running, and the renderer has nothing to
 * render rather than a stale number to hedge.
 *
 * Total sessions and last activity are durable facts: they cannot go stale,
 * because nothing about them depends on a process being alive.
 *
 * Pure functions over explicit paths, so the whole module unit-tests without
 * Electron. Every read is defensive: a foreign store may be missing, corrupt,
 * locked, or on a schema this build has never seen, and none of those may
 * break the switcher.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { LIVE_STATUSES } from "@daydream-code/shared";
import type { RegistryEntry } from "./registry.js";

// better-sqlite3 reaches this package through @daydream-code/store rather than
// as a direct dependency, and `apps/desktop` is ESM while the binding is CJS.
// Resolving it lazily also means a broken/mismatched native binding degrades
// to "no stats" instead of taking down the main process at import time.
type SqliteRow = Record<string, unknown>;
interface SqliteStatement {
  get(...params: unknown[]): SqliteRow | undefined;
  all(...params: unknown[]): SqliteRow[];
}
interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
type SqliteCtor = new (
  file: string,
  options: { readonly: boolean; fileMustExist: boolean },
) => SqliteDatabase;

let sqliteCtor: SqliteCtor | null | undefined;

function loadSqlite(): SqliteCtor | null {
  if (sqliteCtor !== undefined) return sqliteCtor;
  try {
    const require = createRequire(import.meta.url);
    sqliteCtor = require("better-sqlite3") as SqliteCtor;
  } catch {
    sqliteCtor = null;
  }
  return sqliteCtor;
}

/** Where a project keeps its store. Mirrors the sqlite store provider. */
export function storePath(rootPath: string): string {
  return join(rootPath, ".daydream-code", "store.sqlite");
}

export interface ProjectStats {
  /** Every session ever dispatched in this project. */
  sessions: number;
  /** `coalesce(ended_at, started_at)` of the most recent session. */
  lastActivityAt: string | null;
  /**
   * Sessions in a live status. `null` means "not knowable from here" — see the
   * module comment. Never zero-as-unknown: zero is a claim, null is not.
   */
  live: number | null;
}

/**
 * Read one project's stats, or null if the store cannot be read at all.
 *
 * `live` is populated only when `trustLive` is set, which the caller may do
 * only for the project whose core it is currently running.
 */
export function readProjectStats(
  rootPath: string,
  trustLive = false,
): ProjectStats | null {
  const file = storePath(rootPath);
  if (!existsSync(file)) return null;
  const Sqlite = loadSqlite();
  if (Sqlite === null) return null;

  let db: SqliteDatabase | null = null;
  try {
    db = new Sqlite(file, { readonly: true, fileMustExist: true });
    if (!hasSessionsTable(db)) return null;
    const columns = tableColumns(db, "sessions");
    // A store old enough to lack these is a store this build cannot read
    // honestly, so it reports nothing rather than a partial truth.
    if (!columns.has("started_at") || !columns.has("status")) return null;

    const activity = columns.has("ended_at")
      ? "max(coalesce(ended_at, started_at))"
      : "max(started_at)";
    const row = db
      .prepare(`select count(*) as n, ${activity} as last from sessions`)
      .get();
    const sessions = asCount(row?.n);
    const lastActivityAt = typeof row?.last === "string" ? row.last : null;

    let live: number | null = null;
    if (trustLive) {
      const placeholders = LIVE_STATUSES.map(() => "?").join(", ");
      const liveRow = db
        .prepare(`select count(*) as n from sessions where status in (${placeholders})`)
        .get(...LIVE_STATUSES);
      live = asCount(liveRow?.n);
    }

    return { sessions, lastActivityAt, live };
  } catch {
    // Corrupt, locked, encrypted, or a schema we guessed wrong about.
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Closing a database that failed to open is not an error worth having.
    }
  }
}

function hasSessionsTable(db: SqliteDatabase): boolean {
  const row = db
    .prepare("select name from sqlite_master where type = 'table' and name = 'sessions'")
    .get();
  return row !== undefined;
}

function tableColumns(db: SqliteDatabase, table: string): Set<string> {
  const rows = db.prepare(`pragma table_info(${table})`).all();
  return new Set(
    rows
      .map((row) => row.name)
      .filter((name): name is string => typeof name === "string"),
  );
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** A registry entry plus everything the switcher can honestly say about it. */
export interface ProjectSummary extends RegistryEntry {
  /** False when the folder is gone: the row still lists, but cannot be opened. */
  exists: boolean;
  /** True for the project whose core is running in this process. */
  active: boolean;
  /** Null when the store is absent or unreadable. */
  stats: ProjectStats | null;
}

/**
 * Summarize the registry. Ordering is left to the caller (the renderer sorts,
 * so a filtered list re-ranks without a round trip).
 */
export function summarizeProjects(
  entries: readonly RegistryEntry[],
  activeRootPath: string | null,
): ProjectSummary[] {
  return entries.map((entry) => {
    const active = entry.rootPath === activeRootPath;
    const exists = existsSync(entry.rootPath);
    return {
      ...entry,
      exists,
      active,
      stats: exists ? readProjectStats(entry.rootPath, active) : null,
    };
  });
}
