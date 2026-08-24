import { describe, expect, it } from "vitest";
import {
  compareSessionRecency,
  sessionActivityAt,
  type SessionRecord,
} from "@daydream-code/shared";

type Row = Pick<SessionRecord, "name" | "startedAt" | "endedAt">;

function row(name: string, startedAt: string, endedAt: string | null): Row {
  return { name, startedAt, endedAt };
}

describe("sessionActivityAt", () => {
  it("is the finish time once a session has finished", () => {
    expect(
      sessionActivityAt(row("a", "2026-08-23T01:00:00.000Z", "2026-08-23T05:00:00.000Z")),
    ).toBe("2026-08-23T05:00:00.000Z");
  });

  it("falls back to the start time while a session is still live", () => {
    expect(sessionActivityAt(row("a", "2026-08-23T01:00:00.000Z", null))).toBe(
      "2026-08-23T01:00:00.000Z",
    );
  });
});

describe("compareSessionRecency", () => {
  it("puts the most recently finished session first", () => {
    // `long` started first and finished last: sorting on start time would bury
    // it, which is the bug this comparator exists to fix.
    const long = row("long", "2026-08-23T01:00:00.000Z", "2026-08-23T09:00:00.000Z");
    const quick = row("quick", "2026-08-23T02:00:00.000Z", "2026-08-23T02:05:00.000Z");
    expect([quick, long].sort(compareSessionRecency).map((s) => s.name)).toEqual([
      "long",
      "quick",
    ]);
  });

  it("ranks a live session by when it started", () => {
    const live = row("live", "2026-08-23T03:00:00.000Z", null);
    const done = row("done", "2026-08-23T01:00:00.000Z", "2026-08-23T02:00:00.000Z");
    const later = row("later", "2026-08-23T01:00:00.000Z", "2026-08-23T04:00:00.000Z");
    expect([done, live, later].sort(compareSessionRecency).map((s) => s.name)).toEqual([
      "later",
      "live",
      "done",
    ]);
  });

  it("is a total order, so equal timestamps never reshuffle", () => {
    const at = "2026-08-23T02:00:00.000Z";
    const b = row("b", at, at);
    const a = row("a", at, at);
    expect([b, a].sort(compareSessionRecency).map((s) => s.name)).toEqual(["a", "b"]);
    expect([a, b].sort(compareSessionRecency).map((s) => s.name)).toEqual(["a", "b"]);
    expect(compareSessionRecency(a, a)).toBe(0);
  });
});
