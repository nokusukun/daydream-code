import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  readProjectStats,
  storePath,
  summarizeProjects,
  type ProjectStats,
} from "../electron/stats.js";
import type { RegistryEntry } from "../electron/registry.js";

const dirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "daydream-stats-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

interface SessionSeed {
  status: string;
  startedAt: string;
  endedAt?: string | null;
}

/** A project with a store shaped like the real one. */
function seedProject(sessions: SessionSeed[], opts: { endedAt?: boolean } = {}): string {
  const root = tmp();
  const file = storePath(root);
  mkdirSync(join(root, ".daydream-code"), { recursive: true });
  const db = new Database(file);
  db.exec(
    opts.endedAt === false
      ? `create table sessions (id text primary key, status text not null, started_at text not null)`
      : `create table sessions (
           id text primary key,
           status text not null,
           started_at text not null,
           ended_at text
         )`,
  );
  sessions.forEach((session, i) => {
    if (opts.endedAt === false) {
      db.prepare("insert into sessions (id, status, started_at) values (?, ?, ?)").run(
        `ses_${i}`,
        session.status,
        session.startedAt,
      );
    } else {
      db.prepare(
        "insert into sessions (id, status, started_at, ended_at) values (?, ?, ?, ?)",
      ).run(`ses_${i}`, session.status, session.startedAt, session.endedAt ?? null);
    }
  });
  db.close();
  return root;
}

describe("readProjectStats", () => {
  it("counts every session and reports the latest activity", () => {
    const root = seedProject([
      { status: "completed", startedAt: "2026-08-01T00:00:00.000Z", endedAt: "2026-08-01T01:00:00.000Z" },
      { status: "completed", startedAt: "2026-08-02T00:00:00.000Z", endedAt: "2026-08-05T09:00:00.000Z" },
      { status: "completed", startedAt: "2026-08-03T00:00:00.000Z", endedAt: "2026-08-03T02:00:00.000Z" },
    ]);
    expect(readProjectStats(root)).toEqual({
      sessions: 3,
      lastActivityAt: "2026-08-05T09:00:00.000Z",
      live: null,
    } satisfies ProjectStats);
  });

  it("uses started_at for a session that has not ended", () => {
    const root = seedProject([
      { status: "completed", startedAt: "2026-08-01T00:00:00.000Z", endedAt: "2026-08-01T01:00:00.000Z" },
      { status: "running", startedAt: "2026-08-09T12:00:00.000Z", endedAt: null },
    ]);
    expect(readProjectStats(root)?.lastActivityAt).toBe("2026-08-09T12:00:00.000Z");
  });

  it("withholds live state unless the caller says it is entitled to it", () => {
    const seeds: SessionSeed[] = [
      { status: "running", startedAt: "2026-08-09T12:00:00.000Z", endedAt: null },
      { status: "waiting", startedAt: "2026-08-09T13:00:00.000Z", endedAt: null },
      { status: "completed", startedAt: "2026-08-01T00:00:00.000Z", endedAt: "2026-08-01T01:00:00.000Z" },
    ];
    const root = seedProject(seeds);
    // A closed project's `running` rows may be a crashed process's residue, so
    // there is no number to show rather than a number that might be a lie.
    expect(readProjectStats(root, false)?.live).toBeNull();
    // `waiting` counts too: it is a live status, and one that is blocked on us.
    expect(readProjectStats(root, true)?.live).toBe(2);
  });

  it("reads a store with no ended_at column by falling back to started_at", () => {
    const root = seedProject(
      [
        { status: "completed", startedAt: "2026-08-01T00:00:00.000Z" },
        { status: "completed", startedAt: "2026-08-07T00:00:00.000Z" },
      ],
      { endedAt: false },
    );
    expect(readProjectStats(root)).toEqual({
      sessions: 2,
      lastActivityAt: "2026-08-07T00:00:00.000Z",
      live: null,
    });
  });

  it("returns null when there is no store at all", () => {
    expect(readProjectStats(tmp())).toBeNull();
  });

  it("returns null for a file that is not a database", () => {
    const root = tmp();
    mkdirSync(join(root, ".daydream-code"), { recursive: true });
    writeFileSync(storePath(root), "this is not sqlite", "utf8");
    expect(readProjectStats(root)).toBeNull();
  });

  it("returns null for a database with no sessions table", () => {
    const root = tmp();
    mkdirSync(join(root, ".daydream-code"), { recursive: true });
    const db = new Database(storePath(root));
    db.exec("create table projects (id text primary key)");
    db.close();
    expect(readProjectStats(root)).toBeNull();
  });

  it("returns null rather than guessing when the schema is unrecognized", () => {
    const root = tmp();
    mkdirSync(join(root, ".daydream-code"), { recursive: true });
    const db = new Database(storePath(root));
    db.exec("create table sessions (id text primary key, headline text)");
    db.close();
    expect(readProjectStats(root)).toBeNull();
  });

  it("does not write to the project it reads", () => {
    const root = seedProject([
      { status: "completed", startedAt: "2026-08-01T00:00:00.000Z", endedAt: null },
    ]);
    readProjectStats(root, true);
    const db = new Database(storePath(root), { readonly: true });
    const journalMode = db.pragma("journal_mode", { simple: true });
    db.close();
    // Opening read-only cannot promote the journal, which is the observable
    // shape of "we did not touch it".
    expect(journalMode).toBe("delete");
  });
});

describe("summarizeProjects", () => {
  function entry(rootPath: string, name: string): RegistryEntry {
    return { rootPath, name, lastOpenedAt: "2026-08-01T00:00:00.000Z" };
  }

  it("marks the open project active and gives only it a live count", () => {
    const open = seedProject([
      { status: "running", startedAt: "2026-08-09T12:00:00.000Z", endedAt: null },
    ]);
    const closed = seedProject([
      { status: "running", startedAt: "2026-08-02T12:00:00.000Z", endedAt: null },
    ]);

    const summaries = summarizeProjects(
      [entry(open, "open"), entry(closed, "closed")],
      open,
    );

    expect(summaries[0]?.active).toBe(true);
    expect(summaries[0]?.stats?.live).toBe(1);
    expect(summaries[1]?.active).toBe(false);
    // Same row in the same state, and still no live count: the difference is
    // whether a core is running here, not what the database says.
    expect(summaries[1]?.stats?.live).toBeNull();
    expect(summaries[1]?.stats?.sessions).toBe(1);
  });

  it("trusts live counts for retained background cores without marking them active", () => {
    const open = seedProject([
      { status: "running", startedAt: "2026-08-09T12:00:00.000Z", endedAt: null },
    ]);
    const background = seedProject([
      { status: "waiting", startedAt: "2026-08-09T13:00:00.000Z", endedAt: null },
    ]);

    const summaries = summarizeProjects(
      [entry(open, "open"), entry(background, "background")],
      open,
      new Set([open, background]),
    );

    expect(summaries[0]).toMatchObject({ active: true, stats: { live: 1 } });
    expect(summaries[1]).toMatchObject({ active: false, stats: { live: 1 } });
  });

  it("flags a project whose folder is gone and does not try to read it", () => {
    const gone = join(tmpdir(), "daydream-stats-does-not-exist-4a7f");
    const summaries = summarizeProjects([entry(gone, "gone")], null);
    expect(summaries[0]?.exists).toBe(false);
    expect(summaries[0]?.stats).toBeNull();
  });

  it("keeps a project with no store in the list, without facts", () => {
    const bare = tmp();
    const summaries = summarizeProjects([entry(bare, "bare")], null);
    expect(summaries[0]?.exists).toBe(true);
    expect(summaries[0]?.stats).toBeNull();
    expect(summaries[0]?.name).toBe("bare");
  });

  it("returns nothing for an empty registry rather than throwing", () => {
    expect(summarizeProjects([], null)).toEqual([]);
  });
});
