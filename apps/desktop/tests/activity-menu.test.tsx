import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SessionRecord } from "@daydream-code/shared";
import type { ConnectionInfo } from "../src/bridge.js";
import {
  liveProjectActivities,
  latestFinishedActivity,
  projectProgress,
  type ProjectActivity,
} from "../src/project-activity.js";
import { ProjectGroup, Summary } from "../src/views/ActivityMenu.js";

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
  endedAt: string | null = null,
): SessionRecord {
  return {
    id: `ses_${name}` as SessionRecord["id"],
    projectId: "prj" as SessionRecord["projectId"],
    threadId: "thr" as SessionRecord["threadId"],
    name,
    title: `${name} title`,
    task: name,
    driver: "mock",
    modelId: null,
    status,
    lastSeenMasterSeq: 0,
    startedAt: "2026-08-01T00:00:00.000Z",
    endedAt,
    summary: null,
    tldr: null,
    usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
  };
}

function render(
  project: ReturnType<typeof projectProgress>[number],
  onOpenProject?: (rootPath: string) => void,
): string {
  return renderToStaticMarkup(
    <ProjectGroup
      project={project}
      now={Date.parse("2026-08-01T02:00:00.000Z")}
      onOpenProject={onOpenProject}
      onOpenSession={() => undefined}
    />,
  );
}

describe("<ProjectGroup>", () => {
  const beta = connection("beta");

  it("draws a loaded project that has never run, rather than omitting it", () => {
    const [only] = projectProgress([beta], [], "/projects/alpha");
    const html = render(only!, () => undefined);
    expect(html).toContain("beta");
    expect(html).toContain("idle");
    expect(html).toContain("no runs yet");
    // A quiet project keeps its track: a row with no meter reads as a row
    // that failed to draw, not as one with nothing to report.
    expect(html).toContain("sweep-idle");
  });

  it("reports the outcome of the last run when nothing is live", () => {
    const [only] = projectProgress(
      [beta],
      [
        {
          connection: beta,
          session: session("old", "failed", "2026-08-01T01:00:00.000Z"),
        },
      ],
      "/projects/alpha",
    );
    expect(render(only!)).toContain("last run failed · old title");
  });

  it("says it is still checking a project whose core has not answered", () => {
    const [project] = projectProgress(
      [connection("alpha")],
      [],
      "/projects/alpha",
      new Set(),
    );
    const html = render(project!);
    // Once, not twice: the header carries it, and the body line below it
    // answers "what happened last", which is not a question this project can
    // answer yet.
    expect(html.match(/checking\u2026/g)).toHaveLength(1);
    expect(html).not.toContain("no runs yet");
    expect(html).toContain("sweep-unknown");
  });

  it("offers the switch only for a project you are not already in", () => {
    const [here] = projectProgress([beta], [], beta.rootPath);
    expect(render(here!, () => undefined)).toContain("disabled");
    const [there] = projectProgress([beta], [], "/projects/alpha");
    expect(render(there!, () => undefined)).not.toContain("disabled");
    // No bridge to switch with is the same answer as being here already.
    expect(render(there!)).toContain("disabled");
  });
});

describe("<Summary>", () => {
  const alpha = connection("alpha");
  const beta = connection("beta");
  const gamma = connection("gamma");

  const answered = new Set([alpha.rootPath, beta.rootPath, gamma.rootPath]);

  function summary(
    activities: readonly ProjectActivity[],
    currentRootPath = alpha.rootPath,
    known: ReadonlySet<string> = answered,
  ): string {
    const live = liveProjectActivities(activities);
    return renderToStaticMarkup(
      <Summary
        live={live}
        projects={projectProgress(
          [alpha, beta, gamma],
          activities,
          currentRootPath,
          known,
        )}
        waiting={live.filter((a) => a.session.status === "waiting").length}
        lastDone={latestFinishedActivity(activities)}
        currentRootPath={currentRootPath}
      />,
    );
  }

  it("names the project when the one live run is somewhere else", () => {
    const html = summary([
      { connection: beta, session: session("build", "running") },
    ]);
    expect(html).toContain("build title · beta");
  });

  it("leaves the project unnamed when the run is the one you are looking at", () => {
    const html = summary([
      { connection: alpha, session: session("build", "running") },
    ]);
    expect(html).toContain("build title");
    expect(html).not.toContain("· alpha");
  });

  it("counts runs when they are all in one project", () => {
    const html = summary([
      { connection: alpha, session: session("one", "running") },
      { connection: alpha, session: session("two", "running") },
    ]);
    expect(html).toContain("2 agents running");
  });

  it("names the projects, and their counts, once work is spread across them", () => {
    const html = summary([
      { connection: alpha, session: session("one", "running") },
      { connection: alpha, session: session("two", "running") },
      { connection: beta, session: session("three", "running") },
    ]);
    expect(html).toContain("alpha 2 · beta 1");
    expect(html).not.toContain("3 agents");
  });

  it("puts a run blocked on you ahead of the tally, wherever it is", () => {
    const html = summary([
      { connection: alpha, session: session("one", "running") },
      { connection: beta, session: session("ask", "waiting") },
    ]);
    expect(html).toContain("ask title · beta, waiting on you");
  });

  it("falls back to the last outcome across every project, then to idle", () => {
    expect(
      summary([
        {
          connection: beta,
          session: session("old", "failed", "2026-08-01T01:00:00.000Z"),
        },
      ]),
    ).toContain("Last run failed · old title · beta");
    expect(summary([])).toContain("Idle");
  });

  /**
   * `Idle` is a claim about every loaded project, and before their cores have
   * answered there is nothing to base it on. This is the state the toolbar was
   * in for a beat after every project switch.
   */
  it("says it is still looking rather than claiming idle", () => {
    const html = summary([], alpha.rootPath, new Set());
    expect(html).toContain("Checking…");
    expect(html).not.toContain("Idle");
  });

  it("claims idle only once every project has answered", () => {
    expect(summary([], alpha.rootPath, answered)).toContain("Idle");
  });

  it("reports a run it can see even while another project is still loading", () => {
    const html = summary(
      [{ connection: beta, session: session("build", "running") }],
      alpha.rootPath,
      new Set([beta.rootPath]),
    );
    expect(html).toContain("build title · beta");
    expect(html).not.toContain("Checking…");
  });
});
