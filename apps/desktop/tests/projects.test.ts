import { describe, expect, it } from "vitest";
import type { ProjectSummary } from "../src/bridge.js";
import {
  compareProjectRecency,
  displayParent,
  projectActivityAt,
  projectFacts,
  projectMatches,
  rankProjects,
} from "../src/projects.js";

function project(over: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    rootPath: "/Users/dev/projects/alpha",
    name: "alpha",
    lastOpenedAt: "2026-08-01T00:00:00.000Z",
    exists: true,
    active: false,
    stats: null,
    ...over,
  };
}

describe("projectActivityAt", () => {
  it("prefers session activity over the moment the folder was opened", () => {
    const p = project({
      lastOpenedAt: "2026-08-01T00:00:00.000Z",
      stats: { sessions: 3, lastActivityAt: "2026-08-04T09:00:00.000Z", live: null },
    });
    expect(projectActivityAt(p)).toBe("2026-08-04T09:00:00.000Z");
  });

  it("falls back to lastOpenedAt for a project with no store yet", () => {
    expect(projectActivityAt(project({ stats: null }))).toBe("2026-08-01T00:00:00.000Z");
  });

  it("falls back when a store exists but has never run a session", () => {
    const p = project({ stats: { sessions: 0, lastActivityAt: null, live: null } });
    expect(projectActivityAt(p)).toBe("2026-08-01T00:00:00.000Z");
  });
});

describe("ranking", () => {
  it("puts the most recently active project first, whichever key supplied it", () => {
    const opened = project({
      name: "opened-recently",
      rootPath: "/w/opened",
      lastOpenedAt: "2026-08-05T00:00:00.000Z",
    });
    const worked = project({
      name: "worked-recently",
      rootPath: "/w/worked",
      lastOpenedAt: "2026-07-01T00:00:00.000Z",
      stats: { sessions: 9, lastActivityAt: "2026-08-06T00:00:00.000Z", live: null },
    });
    expect(rankProjects([opened, worked], "").map((p) => p.name)).toEqual([
      "worked-recently",
      "opened-recently",
    ]);
  });

  it("is a total order: equal timestamps break by name", () => {
    const a = project({ name: "beta", rootPath: "/w/beta" });
    const b = project({ name: "alpha", rootPath: "/w/alpha" });
    expect(compareProjectRecency(a, b)).toBeGreaterThan(0);
    expect(compareProjectRecency(b, a)).toBeLessThan(0);
    expect(compareProjectRecency(a, a)).toBe(0);
  });

  it("does not mutate the input array", () => {
    const list = [
      project({ name: "b", rootPath: "/w/b", lastOpenedAt: "2026-08-01T00:00:00.000Z" }),
      project({ name: "a", rootPath: "/w/a", lastOpenedAt: "2026-08-09T00:00:00.000Z" }),
    ];
    const before = list.map((p) => p.name);
    rankProjects(list, "");
    expect(list.map((p) => p.name)).toEqual(before);
  });
});

describe("projectMatches", () => {
  const p = project({ name: "daydream-code", rootPath: "/Users/dev/projects/daydream-code" });

  it("matches every term, in any order, across name and path", () => {
    expect(projectMatches(p, "day code")).toBe(true);
    expect(projectMatches(p, "code day")).toBe(true);
    expect(projectMatches(p, "projects")).toBe(true);
    expect(projectMatches(p, "DAYDREAM")).toBe(true);
  });

  it("rejects when any term is absent", () => {
    expect(projectMatches(p, "day missing")).toBe(false);
  });

  it("treats an empty or whitespace query as no filter", () => {
    expect(projectMatches(p, "")).toBe(true);
    expect(projectMatches(p, "   ")).toBe(true);
  });

  it("separates two projects sharing a name by their path", () => {
    const work = project({ name: "api", rootPath: "/Users/dev/work/api" });
    const play = project({ name: "api", rootPath: "/Users/dev/play/api" });
    expect(rankProjects([work, play], "work").map((p) => p.rootPath)).toEqual([
      "/Users/dev/work/api",
    ]);
  });
});

describe("displayParent", () => {
  const home = "/Users/dev";

  it("shows the holding folder, not the project folder", () => {
    expect(displayParent("/Users/dev/projects/alpha", home)).toBe("~/projects");
  });

  it("collapses a project sitting directly in home to ~", () => {
    expect(displayParent("/Users/dev/alpha", home)).toBe("~");
  });

  it("leaves paths outside home alone", () => {
    expect(displayParent("/opt/src/alpha", home)).toBe("/opt/src");
  });

  it("prints / rather than an empty line for a project at the root", () => {
    expect(displayParent("/alpha", home)).toBe("/");
  });

  it("tolerates a trailing slash on home", () => {
    expect(displayParent("/Users/dev/projects/alpha", "/Users/dev/")).toBe("~/projects");
  });

  it("does not collapse a sibling directory that merely starts with home", () => {
    expect(displayParent("/Users/deverson/projects/alpha", home)).toBe(
      "/Users/deverson/projects",
    );
  });
});

describe("projectFacts", () => {
  it("labels session counts as threads, in the singular when there is one", () => {
    expect(
      projectFacts(project({ stats: { sessions: 1, lastActivityAt: null, live: null } })),
    ).toEqual(["1 thread"]);
    expect(
      projectFacts(project({ stats: { sessions: 4, lastActivityAt: null, live: null } })),
    ).toEqual(["4 threads"]);
  });

  it("says nothing at all when the store could not be read", () => {
    expect(projectFacts(project({ stats: null }))).toEqual([]);
  });

  it("reports live sessions only when a count was supplied", () => {
    const closed = project({ stats: { sessions: 4, lastActivityAt: null, live: null } });
    const open = project({
      active: true,
      stats: { sessions: 4, lastActivityAt: null, live: 2 },
    });
    expect(projectFacts(closed)).toEqual(["4 threads"]);
    expect(projectFacts(open)).toEqual(["4 threads", "2 live"]);
  });

  it("stays quiet about zero live sessions rather than printing 0", () => {
    const open = project({
      active: true,
      stats: { sessions: 4, lastActivityAt: null, live: 0 },
    });
    expect(projectFacts(open)).toEqual(["4 threads"]);
  });

  it("replaces the facts entirely when the folder is gone", () => {
    const gone = project({
      exists: false,
      stats: { sessions: 4, lastActivityAt: null, live: null },
    });
    expect(projectFacts(gone)).toEqual(["folder is missing"]);
  });
});
