import { describe, expect, it } from "vitest";
import {
  zeroUsage,
  type SessionRecord,
  type SessionStatus,
} from "@daydream-code/shared";
import { RAIL_PAGE, isArchived, railSessions } from "../src/sessions.js";

/**
 * The rail's paging and shelving rules, as a pure function.
 *
 * These are unit tests rather than render tests on purpose: what can go wrong
 * here is a run being *absent* from a list, and a render test that asserts on
 * what it can see is the wrong instrument for finding something missing.
 */
function session(
  name: string,
  status: SessionStatus,
  endedAt: string | null,
  archivedAt: string | null = null,
): SessionRecord {
  return {
    id: `ses_${name}` as SessionRecord["id"],
    projectId: "proj_1" as SessionRecord["projectId"],
    threadId: "thr_1" as SessionRecord["threadId"],
    name,
    title: name,
    task: name,
    driver: "mock",
    modelId: null,
    status,
    lastSeenMasterSeq: 0,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt,
    summary: null,
    tldr: null,
    archivedAt,
    usage: zeroUsage(),
  };
}

/** `n` finished runs, oldest first, one minute apart. */
function finishedRuns(n: number): SessionRecord[] {
  return Array.from({ length: n }, (_unused, i) =>
    session(
      `run-${String(i).padStart(3, "0")}`,
      "completed",
      `2026-01-01T00:${String(i).padStart(2, "0")}:00.000Z`,
    ),
  );
}

describe("railSessions", () => {
  it("shows everything while the list is short", () => {
    const rail = railSessions(finishedRuns(3));
    expect(rail.finished).toHaveLength(3);
    expect(rail.more).toBe(0);
  });

  it("cuts finished runs at the page size and counts the rest", () => {
    const rail = railSessions(finishedRuns(62));
    expect(rail.finished).toHaveLength(RAIL_PAGE);
    expect(rail.more).toBe(12);
  });

  it("keeps the most recent runs, not the first ones it happened to see", () => {
    const rail = railSessions(finishedRuns(60), { shown: 2 });
    expect(rail.finished.map((s) => s.name)).toEqual(["run-059", "run-058"]);
  });

  it("reveals the next page without losing the first", () => {
    const rail = railSessions(finishedRuns(62), { shown: RAIL_PAGE * 2 });
    expect(rail.finished).toHaveLength(62);
    expect(rail.more).toBe(0);
  });

  /**
   * The failure worth ruling out: a busy project with more than fifty finished
   * runs pushing a running session off the bottom of the rail, which is the
   * one row the rail exists to show.
   */
  it("never counts live runs against the cap", () => {
    const rail = railSessions(
      [
        ...finishedRuns(60),
        session("still-going", "running", null),
        session("needs-you", "waiting", null),
      ],
      { shown: 1 },
    );
    expect(rail.live.map((s) => s.name)).toEqual(["needs-you", "still-going"]);
    expect(rail.finished).toHaveLength(1);
  });

  it("puts a run blocked on you above one that is proceeding fine", () => {
    const rail = railSessions([
      session("running", "running", null),
      session("waiting", "waiting", null),
    ]);
    expect(rail.live.map((s) => s.status)).toEqual(["waiting", "running"]);
  });

  it("takes archived runs out of the rail entirely", () => {
    const rail = railSessions([
      session("kept", "completed", "2026-01-01T00:02:00.000Z"),
      session("shelved", "completed", "2026-01-01T00:03:00.000Z", "2026-01-02"),
    ]);
    expect(rail.finished.map((s) => s.name)).toEqual(["kept"]);
    // Shelved runs are handed over for the archive window, never drawn in the
    // list they were taken out of.
    expect(rail.archived.map((s) => s.name)).toEqual(["shelved"]);
  });

  /**
   * The rule the whole feature rests on: paging hides runs, archiving is the
   * only thing that removes one, and paging must never turn into archiving.
   */
  it("never archives a run just because it fell past the cut", () => {
    const runs = finishedRuns(80);
    const rail = railSessions(runs, { shown: 10 });
    expect(rail.archived).toEqual([]);
    expect(rail.more).toBe(70);
    expect(runs.every((s) => s.archivedAt === null)).toBe(true);
  });

  /** Shelving has to buy back a row, or it does not lean the list at all. */
  it("frees a slot under the cap when a run is archived", () => {
    const runs = finishedRuns(51);
    const capped = railSessions(runs);
    expect(capped.more).toBe(1);

    const shelved = runs.map((s, i) =>
      i === 0 ? { ...s, archivedAt: "2026-01-02T00:00:00.000Z" } : s,
    );
    const rail = railSessions(shelved);
    expect(rail.more).toBe(0);
    expect(rail.finished).toHaveLength(50);
  });

  it("hands back the shelf most recent first, and never in the rail", () => {
    const rail = railSessions([
      session("old", "completed", "2026-01-01T00:01:00.000Z", "2026-01-02"),
      session("new", "completed", "2026-01-01T00:09:00.000Z", "2026-01-02"),
    ]);
    expect(rail.archived.map((s) => s.name)).toEqual(["new", "old"]);
    expect(rail.finished).toEqual([]);
    // The shelf is not capped: the archive window shows all of it.
    expect(rail.more).toBe(0);
  });

  /**
   * A crash can leave `archived_at` on a row whose process is still marked
   * live. Visibility wins: the alternative is a running session nobody sees.
   */
  it("shows a live run even if it is somehow flagged archived", () => {
    const rail = railSessions([
      session("zombie", "running", null, "2026-01-02T00:00:00.000Z"),
    ]);
    expect(rail.live.map((s) => s.name)).toEqual(["zombie"]);
    expect(rail.archived).toEqual([]);
  });

  /**
   * The regression that emptied a real sidebar.
   *
   * Vite reloads the renderer but cannot reload the harness process behind it,
   * so a running app pairs new UI with a core that predates the column and
   * sends no `archivedAt` at all. `archivedAt !== null` is true for
   * `undefined`, so all 42 runs were classified as shelved and the rail showed
   * nothing but "Archived… 42".
   */
  it("treats a run from a core that never heard of archiving as visible", () => {
    const legacy = finishedRuns(3).map((s) => {
      const { archivedAt: _dropped, ...rest } = s;
      return rest as SessionRecord;
    });
    const rail = railSessions(legacy);
    expect(rail.finished).toHaveLength(3);
    expect(rail.archived).toEqual([]);
  });

  it("only counts a real timestamp as archived", () => {
    const base = session("run", "completed", "2026-01-01T00:00:00.000Z");
    expect(isArchived(base)).toBe(false);
    expect(isArchived({ ...base, archivedAt: "2026-01-02T00:00:00.000Z" })).toBe(true);
    // Neither an absent field nor an empty string is a shelving decision.
    expect(isArchived({ ...base, archivedAt: undefined as unknown as null })).toBe(false);
    expect(isArchived({ ...base, archivedAt: "" })).toBe(false);
  });

  it("survives a nonsense page size instead of returning a negative count", () => {
    const rail = railSessions(finishedRuns(3), { shown: -5 });
    expect(rail.finished).toEqual([]);
    expect(rail.more).toBe(3);
  });
});
