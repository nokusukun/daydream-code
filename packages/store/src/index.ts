import { Service, type Context } from "@daydream-code/kernel";
import type { ProjectRecord } from "@daydream-code/shared";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";

declare module "@daydream-code/kernel" {
  interface Context {
    store: ProjectStore;
  }
}

/**
 * Exclusive seam: owns the per-project database. One mounted app serves one
 * project; a multi-project host mounts one isolated subtree per project
 * (ctx.isolate("store") and friends).
 *
 * Deliberate deviation from strict seam purity: this package also owns the
 * drizzle schema for all core tables (journal, threads, sessions, projects),
 * because they share one database file and one migration history. Providers
 * of the journal/threads seams consume `db` and the exported tables.
 */
export abstract class ProjectStore extends Service {
  constructor(ctx: Context) {
    super(ctx, "store");
  }

  /** Absolute root of the project this app serves. */
  abstract readonly rootPath: string;
  /** Directory holding harness state: `<rootPath>/.daydream-code`. */
  abstract readonly dataDir: string;
  /** The project row (created on first open). */
  abstract readonly project: ProjectRecord;
  abstract readonly db: BetterSQLite3Database<Record<string, unknown>>;
  abstract readonly sqlite: BetterSqlite3.Database;
}

export * as schema from "./schema.js";
