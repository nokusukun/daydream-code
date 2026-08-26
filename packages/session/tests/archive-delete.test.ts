import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { boot, type BootResult } from "@daydream-code/boot";
import type { PendingQuestion } from "@daydream-code/questions";

/**
 * End to end for the two things the sidebar's right-click menu does, against
 * the real composed system: archiving a finished run, and erasing one.
 *
 * The delete cases are the reason this is an integration test rather than a
 * unit test on the runner. What makes a purge correct is that the journal's
 * `BEFORE DELETE` trigger — real SQL, installed by a migration — lets exactly
 * these rows go and nothing else, and a fake store would not have it.
 */

let dirs: string[] = [];
let systems: BootResult[] = [];

async function bootProject(script: unknown[] = []): Promise<BootResult> {
  const dir = mkdtempSync(join(tmpdir(), "ddc-archive-"));
  dirs.push(dir);
  const result = await boot({
    projectRoot: dir,
    overrides: [
      { id: "driver-mock", disabled: false, config: { id: "mock", script } },
      { id: "driver-claude", disabled: true },
    ],
  });
  systems.push(result);
  return result;
}

/** Dispatch and wait for the run to finish, so the row is idle. */
async function finished(ctx: BootResult["ctx"], task: string) {
  const handle = await ctx.sessions.dispatch({ task, driver: "mock" });
  await handle.done;
  return ctx.sessions.get(handle.record.id)!;
}

const askStep = {
  tool: "ask_user",
  args: {
    questions: [
      {
        question: "keep going?",
        header: "Check",
        // Two options minimum: `ask_user` rejects a one-way question.
        options: [
          { label: "yes", description: "carry on" },
          { label: "no", description: "stop here" },
        ],
      },
    ],
  },
};

/** A run parked mid-turn on a question, i.e. live and not going anywhere. */
async function blocked(ctx: BootResult["ctx"]) {
  const asked = new Promise<PendingQuestion>((resolve) => {
    const off = ctx.on("question/asked", (pending: PendingQuestion) => {
      off();
      resolve(pending);
    });
  });
  const handle = await ctx.sessions.dispatch({ task: "block here", driver: "mock" });
  await asked;
  return ctx.sessions.get(handle.record.id)!;
}

afterEach(async () => {
  for (const system of systems) {
    await system.app.dispose(system.app.rootFiber).catch(() => undefined);
  }
  systems = [];
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("archiving a run", () => {
  it("stamps and clears archivedAt, and the list carries it", async () => {
    const { ctx } = await bootProject([{ turn: "done" }]);
    const session = await finished(ctx, "shelve me");
    expect(session.archivedAt).toBeNull();

    const archived = ctx.sessions.setArchived(session.id, true);
    expect(archived.archivedAt).not.toBeNull();
    expect(ctx.sessions.list().find((s) => s.id === session.id)!.archivedAt)
      .not.toBeNull();

    expect(ctx.sessions.setArchived(session.id, false).archivedAt).toBeNull();
    expect(
      ctx.sessions.list().find((s) => s.id === session.id)!.archivedAt,
    ).toBeNull();
  });

  it("announces the change so a connected client can move the row", async () => {
    const { ctx } = await bootProject([{ turn: "done" }]);
    const session = await finished(ctx, "watch me");
    const seen: Array<string | null> = [];
    const off = ctx.on("session/updated", (s: { id: string; archivedAt: string | null }) => {
      if (s.id === session.id) seen.push(s.archivedAt);
    });
    ctx.sessions.setArchived(session.id, true);
    off();
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBeNull();
  });

  it("refuses a live run, because the rail must not hide working sessions", async () => {
    const { ctx } = await bootProject([askStep, { turn: "done" }]);
    const session = await blocked(ctx);
    expect(session.status).toBe("waiting");
    expect(() => ctx.sessions.setArchived(session.id, true)).toThrow(/stop it first/);
    ctx.questions.settleCurrent(session.id, { kind: "declined" });
  });

  /**
   * The failure this guards is a session archived while idle, continued, and
   * then working invisibly: the row would still be filtered out of the rail
   * while it spent tokens.
   */
  it("un-shelves a run that is continued", async () => {
    const { ctx } = await bootProject([{ turn: "one" }, { turn: "two" }]);
    const session = await finished(ctx, "come back");
    ctx.sessions.setArchived(session.id, true);

    const handle = await ctx.sessions.continueSession(session.id, "again");
    await handle.done;
    expect(ctx.sessions.get(session.id)!.archivedAt).toBeNull();
  });
});

describe("deleting a run", () => {
  it("erases the row and its journal, and leaves other runs alone", async () => {
    const { ctx } = await bootProject([{ turn: "done" }]);
    const doomed = await finished(ctx, "erase me");
    const keeper = await finished(ctx, "keep me");
    expect(ctx.journal.read({ sessionId: doomed.id, limit: 500 }).length)
      .toBeGreaterThan(0);

    const removed = ctx.sessions.remove(doomed.id);
    expect(removed.name).toBe(doomed.name);

    expect(ctx.sessions.get(doomed.id)).toBeUndefined();
    expect(ctx.journal.read({ sessionId: doomed.id, limit: 500 })).toHaveLength(0);
    expect(ctx.sessions.list().map((s) => s.id)).toEqual([keeper.id]);
    // The neighbour's transcript is untouched, so the trigger scoped the
    // exemption to one session rather than opening the journal generally.
    expect(ctx.journal.read({ sessionId: keeper.id, limit: 500 }).length)
      .toBeGreaterThan(0);
  });

  /**
   * A half-deleted session is the state worth ruling out: the row gone but the
   * transcript still answering `search_journal`, which is what a Delete built
   * on `DELETE FROM sessions` alone would leave behind.
   */
  it("takes the transcript out of journal search too", async () => {
    const { ctx } = await bootProject([{ turn: "the needle sits here" }]);
    const doomed = await finished(ctx, "searchable");
    expect(ctx.journal.search("the needle sits here", { limit: 50 }).length)
      .toBeGreaterThan(0);

    ctx.sessions.remove(doomed.id);
    expect(ctx.journal.search("the needle sits here", { limit: 50 })).toHaveLength(0);
  });

  it("keeps what the master thread already wrote about it", async () => {
    const { ctx } = await bootProject([{ turn: "done" }]);
    const doomed = await finished(ctx, "remembered anyway");
    const master = ctx.threads.ensureMaster();
    const before = ctx.threads.entries(master.id).length;
    expect(before).toBeGreaterThan(0);

    ctx.sessions.remove(doomed.id);
    // Master entries are the project's memory and every later fork was cut
    // from that history; erasing a run must not rewrite it.
    expect(ctx.threads.entries(master.id).length).toBe(before);
  });

  it("refuses a live run rather than racing the driver that owns the row", async () => {
    const { ctx } = await bootProject([askStep, { turn: "done" }]);
    const session = await blocked(ctx);
    expect(() => ctx.sessions.remove(session.id)).toThrow(/stop it first/);
    expect(ctx.sessions.get(session.id)).toBeDefined();
    ctx.questions.settleCurrent(session.id, { kind: "declined" });
  });

  it("refuses a session that is already gone", async () => {
    const { ctx } = await bootProject([{ turn: "done" }]);
    const doomed = await finished(ctx, "twice");
    ctx.sessions.remove(doomed.id);
    expect(() => ctx.sessions.remove(doomed.id)).toThrow(/unknown session/);
  });
});
