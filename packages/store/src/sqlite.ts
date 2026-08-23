import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Context } from "@daydream-code/kernel";
import {
  ProjectId,
  defaultProjectConfig,
  newId,
  nowIso,
  type ProjectConfig,
  type ProjectRecord,
} from "@daydream-code/shared";
import { ProjectStore } from "./index.js";
import * as schema from "./schema.js";
import { runMigrations } from "./migrations.js";

const SqliteStoreConfig = z.object({
  /** Absolute root of the project this app serves. */
  rootPath: z.string().min(1),
});

type SqliteStoreConfig = z.infer<typeof SqliteStoreConfig>;

/**
 * Default store provider: better-sqlite3 + drizzle at
 * `<rootPath>/.daydream-code/store.sqlite`. Opens (creating the data dir and
 * a `.gitignore` on first run), migrates, and ensures the project row.
 */
export default class SqliteStore extends ProjectStore {
  static inject: string[] = [];
  static Config = SqliteStoreConfig;

  readonly rootPath: string;
  readonly dataDir: string;
  readonly project: ProjectRecord;
  readonly db: BetterSQLite3Database<Record<string, unknown>>;
  readonly sqlite: BetterSqlite3.Database;

  constructor(ctx: Context, config: SqliteStoreConfig) {
    super(ctx);
    this.rootPath = path.resolve(config.rootPath);
    this.dataDir = path.join(this.rootPath, ".daydream-code");
    fs.mkdirSync(this.dataDir, { recursive: true });
    const gitignorePath = path.join(this.dataDir, ".gitignore");
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, "*.sqlite*\n");
    }

    const sqlite = new Database(path.join(this.dataDir, "store.sqlite"));
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("synchronous = NORMAL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
    runMigrations(sqlite);

    this.sqlite = sqlite;
    this.db = drizzle(sqlite, { schema }) as unknown as BetterSQLite3Database<
      Record<string, unknown>
    >;
    this.project = this.#ensureProject();
    ctx.effect(() => () => sqlite.close(), "store.close");
  }

  #ensureProject(): ProjectRecord {
    const t = schema.projects;
    const existing = this.db
      .select()
      .from(t)
      .where(eq(t.rootPath, this.rootPath))
      .get();
    if (existing) {
      return {
        id: ProjectId(existing.id),
        name: existing.name,
        rootPath: existing.rootPath,
        config: JSON.parse(existing.configJson) as ProjectConfig,
        createdAt: existing.createdAt,
      };
    }
    const config = defaultProjectConfig();
    const row = {
      id: newId("proj"),
      name: path.basename(this.rootPath),
      rootPath: this.rootPath,
      configJson: JSON.stringify(config),
      createdAt: nowIso(),
    };
    this.db.insert(t).values(row).run();
    return {
      id: ProjectId(row.id),
      name: row.name,
      rootPath: row.rootPath,
      config,
      createdAt: row.createdAt,
    };
  }
}
