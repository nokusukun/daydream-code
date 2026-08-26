import { describe, expect, it } from "vitest";
import type { SessionRecord } from "@daydream-code/shared";
import type { ConnectionInfo } from "../src/bridge.js";
import {
  busyProjects,
  latestFinishedActivity,
  liveProjectActivities,
  projectProgress,
  projectStatus,
  projectStatusLabel,
  projectTally,
  everyProjectKnown,
  projectsTooltip,
  replaceProjectSessions,
  uniqueConnections,
  type ProjectActivity,
} from "../src/project-activity.js";

function connection(name: string): ConnectionInfo {
  return {
    name,
    rootPath: `/projects/${name}`,
    url: `http://127.0.0.1/${name}`,
    token: `${name}-token`,
  };
}

function session(
  name: string,
  status: SessionRecord["status"],
  startedAt: string,
  endedAt: string | null = null,
): SessionRecord {
  return {
    id: `ses_${name}` as SessionRecord["id"],
    projectId: "prj_test" as SessionRecord["projectId"],
    threadId: "thr_test" as SessionRecord["threadId"],
    name,
    title: name,
    task: name,
    driver: "mock",
    modelId: null,
    status,
    lastSeenMasterSeq: 0,
    startedAt,
    endedAt,
    summary: null,
    tldr: null,
    usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
  };
}

function activity(
  project: string,
  run: SessionRecord,
): ProjectActivity {
  return { connection: connection(project), session: run };
}

describe("project activity", () => {
  it("keeps one connection per project", () => {
    const alpha = connection("alpha");
    expect(uniqueConnections([alpha, { ...alpha, token: "new" }, connection("beta")]))
      .toEqual([alpha, connection("beta")]);
  });

  it("collects live sessions across projects with waiting work first", () => {
    const activities = [
      activity("alpha", session("older", "running", "2026-08-01T00:00:00.000Z")),
      activity("beta", session("newer", "running", "2026-08-03T00:00:00.000Z")),
      activity("gamma", session("question", "waiting", "2026-08-02T00:00:00.000Z")),
      activity(
        "alpha",
        session(
          "done",
          "completed",
          "2026-08-04T00:00:00.000Z",
          "2026-08-04T01:00:00.000Z",
        ),
      ),
    ];

    const live = liveProjectActivities(activities);
    expect(live.map(({ session: run }) => run.name)).toEqual([
      "question",
      "newer",
      "older",
    ]);
    // The three live runs come from three different projects.
    expect(new Set(live.map((a) => a.connection.rootPath)).size).toBe(3);
  });

  it("reports the latest finished session across every retained project", () => {
    const latest = latestFinishedActivity([
      activity(
        "alpha",
        session(
          "first",
          "completed",
          "2026-08-01T00:00:00.000Z",
          "2026-08-01T02:00:00.000Z",
        ),
      ),
      activity(
        "beta",
        session(
          "last",
          "failed",
          "2026-08-01T00:00:00.000Z",
          "2026-08-02T02:00:00.000Z",
        ),
      ),
    ]);
    expect(latest?.connection.name).toBe("beta");
    expect(latest?.session.name).toBe("last");
  });
});

describe("per-project progress", () => {
  const alpha = connection("alpha");
  const beta = connection("beta");
  const gamma = connection("gamma");

  const running = session("build", "running", "2026-08-03T00:00:00.000Z");
  const alsoRunning = session("test", "running", "2026-08-02T00:00:00.000Z");
  const blocked = session("ask", "waiting", "2026-08-01T00:00:00.000Z");
  const finished = session(
    "old",
    "completed",
    "2026-08-01T00:00:00.000Z",
    "2026-08-01T01:00:00.000Z",
  );

  it("reports every loaded project, including ones that have never run", () => {
    const progress = projectProgress(
      [alpha, beta, gamma],
      [
        { connection: alpha, session: running },
        { connection: beta, session: finished },
      ],
      alpha.rootPath,
    );

    expect(progress.map((p) => p.connection.name)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    const quiet = progress.find((p) => p.connection.name === "gamma")!;
    expect(quiet.live).toEqual([]);
    expect(quiet.lastDone).toBeUndefined();
    expect(projectStatus(quiet)).toBe("idle");
    expect(projectStatusLabel(quiet)).toBe("idle");
  });

  it("marks the project the workspace is rendering, and only that one", () => {
    const progress = projectProgress([alpha, beta], [], beta.rootPath);
    expect(progress.map((p) => [p.connection.name, p.current])).toEqual([
      ["beta", true],
      ["alpha", false],
    ]);
  });

  it("orders projects by urgency: blocked, then working, then quiet", () => {
    const progress = projectProgress(
      [alpha, beta, gamma],
      [
        { connection: alpha, session: running },
        { connection: beta, session: blocked },
        { connection: gamma, session: finished },
      ],
      alpha.rootPath,
    );
    expect(progress.map((p) => p.connection.name)).toEqual([
      "beta",
      "alpha",
      "gamma",
    ]);
    expect(progress.map(projectStatus)).toEqual(["waiting", "running", "idle"]);
  });

  it("counts a project's live runs by kind, ignoring finished ones", () => {
    const [only] = projectProgress(
      [alpha],
      [
        { connection: alpha, session: running },
        { connection: alpha, session: alsoRunning },
        { connection: alpha, session: blocked },
        { connection: alpha, session: finished },
      ],
      alpha.rootPath,
    );
    expect([only!.waiting, only!.running]).toEqual([1, 2]);
    expect(projectStatusLabel(only!)).toBe("1 waiting · 2 running");
    expect(only!.lastDone?.session.name).toBe("old");
  });

  it("names every loaded project in the tooltip, busy or not", () => {
    const progress = projectProgress(
      [alpha, beta],
      [{ connection: alpha, session: running }],
      alpha.rootPath,
    );
    expect(projectsTooltip(progress)).toBe(
      "alpha — 1 running (here)\nbeta — idle",
    );
  });

  it("tallies only the busy projects, and counts the ones it left out", () => {
    const progress = projectProgress(
      [alpha, beta, gamma],
      [
        { connection: alpha, session: running },
        { connection: alpha, session: alsoRunning },
        { connection: beta, session: blocked },
        { connection: gamma, session: running },
      ],
      alpha.rootPath,
    );
    expect(busyProjects(progress)).toHaveLength(3);
    expect(projectTally(progress)).toBe("beta 1 · alpha 2 · gamma 1");
    expect(projectTally(progress, 2)).toBe("beta 1 · alpha 2 · +1");
    expect(projectTally(progress.filter((p) => p.live.length === 0))).toBe("");
  });
});

/**
 * The toolbar reported `idle` with a run on screen, and the cause was here
 * rather than in any of the pure folds above: the snapshot arrives as
 * `Map.values()`, and draining it inside the state updater meant React's
 * second pass over that updater stored an empty list. These pin the updater as
 * a pure function of its argument, which is the property React relies on.
 */
describe("replacing a project's rows", () => {
  const rows = new Map([
    ["ses_one", session("one", "waiting", "2026-08-01T00:00:00.000Z")],
  ]);

  it("survives a second pass over the same updater", () => {
    const update = replaceProjectSessions("/projects/alpha", rows.values());
    const before = new Map<string, SessionRecord[]>();

    const first = update(before);
    const second = update(before);

    expect(first.get("/projects/alpha")).toHaveLength(1);
    expect(second.get("/projects/alpha")).toHaveLength(1);
  });

  it("leaves the other projects, and the map it was handed, alone", () => {
    const before = new Map<string, SessionRecord[]>([
      ["/projects/beta", [session("two", "running", "2026-08-01T00:00:00.000Z")]],
    ]);

    const next = replaceProjectSessions("/projects/alpha", rows.values())(before);

    expect(next.get("/projects/beta")).toHaveLength(1);
    expect(before.has("/projects/alpha")).toBe(false);
  });
});

describe("projects that have not answered yet", () => {
  const alpha = connection("alpha");
  const beta = connection("beta");

  it("treats an unread project as unknown rather than idle", () => {
    const [first, second] = projectProgress(
      [alpha, beta],
      [],
      alpha.rootPath,
      new Set([alpha.rootPath]),
    );

    expect(projectStatus(first!)).toBe("idle");
    expect(projectStatusLabel(first!)).toBe("idle");
    expect(projectStatus(second!)).toBe("unknown");
    expect(projectStatusLabel(second!)).toBe("checking\u2026");
  });

  it("holds the negative claims back until every project has answered", () => {
    const known = projectProgress([alpha, beta], [], alpha.rootPath, new Set([alpha.rootPath, beta.rootPath]));
    const partial = projectProgress([alpha, beta], [], alpha.rootPath, new Set([alpha.rootPath]));

    expect(everyProjectKnown(known)).toBe(true);
    expect(everyProjectKnown(partial)).toBe(false);
  });

  it("assumes every project answered when no set is given", () => {
    const [only] = projectProgress([alpha], [], alpha.rootPath);
    expect(only!.known).toBe(true);
  });
});
