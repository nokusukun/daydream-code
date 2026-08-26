/**
 * Live sessions across every project core retained by the desktop process.
 *
 * The workspace itself stays connected to one project. This second, small
 * fan-out exists only for the toolbar, which is global window chrome and must
 * keep answering "what is running?" after the visible project changes.
 */
import {
  compareSessionRecency,
  type SessionRecord,
} from "@daydream-code/shared";
import type { ConnectionInfo } from "./bridge.js";
import { isLive } from "./sessions.js";

export interface ProjectActivity {
  connection: ConnectionInfo;
  session: SessionRecord;
}

/**
 * Every retained core, and every run they know about.
 *
 * `connections` is carried separately rather than derived from `activities`
 * because a project that has never dispatched a run contributes no activity —
 * and "loaded but idle" is a state the toolbar has to be able to draw. Deriving
 * the list would make those projects invisible exactly when they are quiet.
 */
export interface ProjectFanout {
  connections: ConnectionInfo[];
  activities: ProjectActivity[];
  /**
   * Projects that have answered at least once. A project missing from this set
   * has not been read yet, which the toolbar must draw differently from one it
   * read and found quiet — `idle` is a claim, and before the first snapshot
   * lands there is nothing to base it on.
   */
  known: ReadonlySet<string>;
}

export function connectionKey(connection: ConnectionInfo): string {
  return `${connection.rootPath}\0${connection.url}\0${connection.token}`;
}

/** De-duplicate by project, preserving the supervisor's order. */
export function uniqueConnections(
  connections: readonly ConnectionInfo[],
): ConnectionInfo[] {
  const seen = new Set<string>();
  return connections.filter((connection) => {
    if (seen.has(connection.rootPath)) return false;
    seen.add(connection.rootPath);
    return true;
  });
}

/**
 * Waiting first, then newest activity, with stable project/name tie-breaks.
 *
 * Module-internal: every ordering it decides reaches a caller through
 * `liveProjectActivities`, `latestFinishedActivity` or `projectProgress`, and
 * those are what the tests assert on — an order is only interesting where it
 * is displayed.
 */
function compareProjectActivity(
  a: ProjectActivity,
  b: ProjectActivity,
): number {
  if (a.session.status === "waiting" && b.session.status !== "waiting") return -1;
  if (b.session.status === "waiting" && a.session.status !== "waiting") return 1;
  const bySession = compareSessionRecency(a.session, b.session);
  if (bySession !== 0) return bySession;
  const byProject = a.connection.name.localeCompare(b.connection.name);
  if (byProject !== 0) return byProject;
  return String(a.session.id).localeCompare(String(b.session.id));
}

export function liveProjectActivities(
  activities: readonly ProjectActivity[],
): ProjectActivity[] {
  return activities.filter(({ session }) => isLive(session)).sort(compareProjectActivity);
}

export function latestFinishedActivity(
  activities: readonly ProjectActivity[],
): ProjectActivity | undefined {
  return activities
    .filter(({ session }) => session.endedAt !== null)
    .sort(compareProjectActivity)[0];
}

/**
 * One row of the toolbar's answer: what a single loaded project is doing.
 *
 * Every retained core gets one of these, including the ones with nothing
 * running. A bar that lists only the busy projects cannot be read as "this is
 * everything that is loaded" — a missing row would mean either "idle" or
 * "never opened", and those are different facts about your work.
 */
export interface ProjectProgress {
  connection: ConnectionInfo;
  /** Live runs in this project, most urgent first. */
  live: ProjectActivity[];
  waiting: number;
  running: number;
  /** Newest finished run, so a quiet project still reports an outcome. */
  lastDone: ProjectActivity | undefined;
  /** True for the project the workspace is currently rendering. */
  current: boolean;
  /** False until this project's core has answered once. */
  known: boolean;
}

/** 0 blocked on a human, 1 working, 2 quiet. Urgency, not alphabet. */
function urgency(project: ProjectProgress): number {
  if (project.waiting > 0) return 0;
  if (project.running > 0) return 1;
  return 2;
}

function finishedAt(project: ProjectProgress): string {
  return project.lastDone?.session.endedAt ?? "";
}

/**
 * Fold the flat fan-out into one entry per loaded project, ordered by how much
 * it wants attention: blocked on you, then working, then quiet. Within a tier
 * the same session ordering the menu already uses, so a project's position and
 * its first run's position never disagree.
 */
export function projectProgress(
  connections: readonly ConnectionInfo[],
  activities: readonly ProjectActivity[],
  currentRootPath: string,
  known?: ReadonlySet<string>,
): ProjectProgress[] {
  const byProject = new Map<string, ProjectActivity[]>();
  for (const activity of activities) {
    const at = byProject.get(activity.connection.rootPath);
    if (at === undefined) byProject.set(activity.connection.rootPath, [activity]);
    else at.push(activity);
  }

  return uniqueConnections(connections)
    .map((connection): ProjectProgress => {
      const mine = byProject.get(connection.rootPath) ?? [];
      const live = liveProjectActivities(mine);
      const waiting = live.filter(
        ({ session }) => session.status === "waiting",
      ).length;
      return {
        connection,
        live,
        waiting,
        running: live.length - waiting,
        lastDone: latestFinishedActivity(mine),
        current: connection.rootPath === currentRootPath,
        known: known === undefined || known.has(connection.rootPath),
      };
    })
    .sort((a, b) => {
      const byUrgency = urgency(a) - urgency(b);
      if (byUrgency !== 0) return byUrgency;
      // Inside a tier the project you are looking at leads, so the menu's
      // first row and the window's title agree whenever nothing more urgent
      // is happening elsewhere. Urgency still outranks it: a sibling blocked
      // on you belongs above the project you are already watching.
      if (a.current !== b.current) return a.current ? -1 : 1;
      const first = a.live[0];
      const second = b.live[0];
      if (first !== undefined && second !== undefined) {
        const byRun = compareProjectActivity(first, second);
        if (byRun !== 0) return byRun;
      }
      // Quiet projects have no live run to rank by, so the most recent finish
      // stands in: the project you last got an answer from sorts above one you
      // opened and never used.
      const byFinish = finishedAt(b).localeCompare(finishedAt(a));
      if (byFinish !== 0) return byFinish;
      return a.connection.name.localeCompare(b.connection.name);
    });
}

/**
 * Has every loaded project answered at least once?
 *
 * Named, and shared by the three places that assert a negative — `idle`,
 * `0 live`, and "Nothing running" — because they are one claim in three
 * shapes. Split across three inline `.every` calls they would drift, and a
 * toolbar that says "nothing is running" beside a row saying `checking…`
 * contradicts itself.
 */
export function everyProjectKnown(
  projects: readonly ProjectProgress[],
): boolean {
  return projects.every((project) => project.known);
}

/** Projects with at least one live run, in the order `projectProgress` gave. */
export function busyProjects(
  projects: readonly ProjectProgress[],
): ProjectProgress[] {
  return projects.filter((project) => project.live.length > 0);
}

/**
 * `alpha 2 · beta 1` — how many runs, and whose.
 *
 * "3 agents across 2 projects" answers how many without answering where, and
 * where is the question a second project makes you ask. Overflow prints as
 * `+2` rather than an ellipsis: a truncated project name still reads as a
 * name, so it would be mistaken for one.
 */
export function projectTally(
  projects: readonly ProjectProgress[],
  max = 3,
): string {
  const busy = busyProjects(projects);
  const shown = busy
    .slice(0, max)
    .map((project) => `${project.connection.name} ${project.live.length}`);
  if (busy.length > shown.length) shown.push(`+${busy.length - shown.length}`);
  return shown.join(" · ");
}

/**
 * The status a project's own bar wears: its most urgent run, or nothing.
 *
 * `unknown` is its own answer rather than a shade of idle. A project whose
 * core has not answered yet is not quiet; we just have not looked.
 */
export function projectStatus(
  project: ProjectProgress,
): "waiting" | "running" | "idle" | "unknown" {
  if (project.waiting > 0) return "waiting";
  if (project.running > 0) return "running";
  return project.known ? "idle" : "unknown";
}

/**
 * `1 waiting · 2 running`, or `idle`. Counts rather than a percentage: a run
 * has no total, so the only honest number is how many of them there are.
 */
export function projectStatusLabel(project: ProjectProgress): string {
  const parts: string[] = [];
  if (project.waiting > 0) parts.push(`${project.waiting} waiting`);
  if (project.running > 0) parts.push(`${project.running} running`);
  if (parts.length > 0) return parts.join(" · ");
  return project.known ? "idle" : "checking…";
}

/**
 * Every loaded project and what it is doing, one per line, for the trigger's
 * tooltip.
 *
 * The button is 260px wide at the narrow breakpoint, so the tally ellipsizes
 * once a third project shows up — and the thing it drops is a project name,
 * which is the part you were reading it for. Hover answers in full without
 * opening the menu.
 */
export function projectsTooltip(
  projects: readonly ProjectProgress[],
): string {
  return projects
    .map(
      (project) =>
        `${project.connection.name} — ${projectStatusLabel(project)}${
          project.current ? " (here)" : ""
        }`,
    )
    .join("\n");
}

/**
 * A state updater that puts one project's rows in the fan-out map.
 *
 * The iterable is drained *here*, when the updater is built, and never inside
 * the updater itself. React re-invokes state updaters — StrictMode does it on
 * every update in development, and a render interrupted by a higher-priority
 * one replays them in production — so an updater that consumed a one-shot
 * iterator would keep the second, empty result. That was not hypothetical: the
 * caller passes `Map.values()`, and the toolbar reported `idle` with a run on
 * screen because the second pass stored `[]` over a project's real sessions.
 */
export function replaceProjectSessions(
  rootPath: string,
  sessions: Iterable<SessionRecord>,
): (
  before: ReadonlyMap<string, SessionRecord[]>,
) => Map<string, SessionRecord[]> {
  const rows = [...sessions];
  return (before) => {
    const next = new Map(before);
    next.set(rootPath, rows);
    return next;
  };
}
