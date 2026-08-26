/**
 * Pure list logic for the project switcher: ranking, filtering, and the two
 * strings a row prints. Kept out of the component so the rules are testable
 * without a DOM, and shared by the popover and the first-run picker, which
 * render the same rows in two frames.
 */
import type { ProjectSummary } from "./bridge.js";

/**
 * The moment a project last did anything, and the key the list ranks on.
 *
 * Real work is better evidence of "where I was" than the act of opening a
 * folder, so session activity wins and the open timestamp is the fallback for
 * a project with no store yet. This is the same shape as `sessionActivityAt`
 * in `@daydream-code/shared` (`ended_at ?? started_at`), for the same reason:
 * the value on screen has to be the value the sort used, or the order reads
 * as a bug.
 */
export function projectActivityAt(project: ProjectSummary): string {
  return project.stats?.lastActivityAt ?? project.lastOpenedAt;
}

/** Most recently active first; name breaks ties so the order is total. */
export function compareProjectRecency(a: ProjectSummary, b: ProjectSummary): number {
  const byActivity = projectActivityAt(b).localeCompare(projectActivityAt(a));
  return byActivity !== 0 ? byActivity : a.name.localeCompare(b.name);
}

/**
 * Every whitespace-separated term must appear somewhere in the name or path,
 * so "day code" finds `~/projects/daydream-code`. Matching the path as well as
 * the name is what makes two folders of the same name separable.
 */
export function projectMatches(project: ProjectSummary, query: string): boolean {
  const trimmed = query.trim().toLowerCase();
  if (trimmed.length === 0) return true;
  const haystack = `${project.name} ${project.rootPath}`.toLowerCase();
  return trimmed.split(/\s+/).every((term) => haystack.includes(term));
}

export function rankProjects(
  projects: readonly ProjectSummary[],
  query: string,
): ProjectSummary[] {
  return projects.filter((p) => projectMatches(p, query)).sort(compareProjectRecency);
}

/**
 * The folder holding the project, with `$HOME` collapsed to `~` the way Finder
 * and every Mac tool print it.
 *
 * The parent rather than the full path: the last segment is almost always the
 * project name, which the row already shows in full, so printing it twice
 * spends the line on nothing. `~` for a project that sits directly in home,
 * and `/` for one at the filesystem root, because an empty second line reads
 * as a rendering fault.
 */
export function displayParent(rootPath: string, home: string): string {
  const segments = rootPath.split(/[\\/]/).filter((s) => s.length > 0);
  segments.pop();
  const parent = rootPath.startsWith("/") ? `/${segments.join("/")}` : segments.join("/");
  return collapseHome(parent === "" ? "/" : parent, home);
}

function collapseHome(path: string, home: string): string {
  if (home.length === 0) return path;
  const trimmed = home.replace(/[\\/]+$/, "");
  if (path === trimmed) return "~";
  if (path.startsWith(`${trimmed}/`)) return `~${path.slice(trimmed.length)}`;
  return path;
}

/**
 * The facts line: what this project holds, and what it is doing if we are
 * entitled to say. A project with no readable store contributes nothing rather
 * than "0 sessions", which would be a claim we cannot support.
 */
export function projectFacts(project: ProjectSummary): string[] {
  if (!project.exists) return ["folder is missing"];
  const stats = project.stats;
  if (stats === null) return [];
  const facts = [stats.sessions === 1 ? "1 session" : `${stats.sessions} sessions`];
  // `live` is null unless a core for the project is retained by this app: an
  // unopened project's `running` rows may be a crashed process's residue.
  if (stats.live !== null && stats.live > 0) facts.push(`${stats.live} live`);
  return facts;
}
