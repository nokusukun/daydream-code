/**
 * The toolbar's centre: what the harness is doing right now, across every
 * project this window has loaded, and a menu of the runs doing it.
 *
 * A window that can have six agents working in it needs one place that answers
 * "is anything happening" without reading a sidebar. The collapsed button is
 * that answer; the menu is the way into whichever run the answer was about.
 *
 * Switching projects does not stop the ones you left, so "here" is the wrong
 * scope for that answer: the menu is grouped by project and lists every
 * retained core, including the quiet ones. A project you cannot see is exactly
 * the project whose progress you cannot otherwise check.
 *
 * Liveness is carried once by the status glyph beside the summary. Inside the
 * menu, project tallies name each state in text; repeating that fact as
 * animated bars and per-thread spinners made the same signal compete with
 * itself.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useHarness } from "../harness.js";
import { useDismiss } from "../overlay.js";
import { ApiClient, ApiError } from "../api.js";
import { elapsedMs, fmtElapsed } from "../sessions.js";
import { NEW_SESSION_DRAFT, draftPreview, useDrafts } from "../drafts.js";
import { StatusGlyph, StopIcon, fmtAgo } from "../ui.js";
import {
  busyProjects,
  everyProjectKnown,
  latestFinishedActivity,
  liveProjectActivities,
  projectProgress,
  projectStatusLabel,
  projectTally,
  projectsTooltip,
  type ProjectActivity,
  type ProjectProgress,
} from "../project-activity.js";
import { useProjectActivities } from "../project-fanout.js";

/**
 * How many projects the collapsed trigger names before it counts the rest.
 * Shared by the text and the bars so the two can never disagree about how much
 * was left out.
 */
const TRIGGER_PROJECTS = 3;

/** Re-render live rows on a clock so their elapsed time actually elapses. */
function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
export function ActivityMenu(props: {
  onOpenProject?: ((rootPath: string) => void) | undefined;
  onOpenProjectSession?: ((rootPath: string, sessionId: string) => void) | undefined;
}): ReactNode {
  const { connection, select, newSession, drafts: draftStore } = useHarness();
  const { connections, activities, known } = useProjectActivities();
  const live = useMemo(() => liveProjectActivities(activities), [activities]);
  const projects = useMemo(
    () => projectProgress(connections, activities, connection.rootPath, known),
    [connections, activities, connection.rootPath, known],
  );
  const drafts = useDrafts(draftStore);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const now = useTicker(live.length > 0);

  useDismiss(rootRef, open, () => setOpen(false));

  const waiting = live.filter(({ session }) => session.status === "waiting");
  const pending = draftPreview(drafts.get(NEW_SESSION_DRAFT));
  // The last run to finish is what "idle" should report on — an empty bar that
  // says nothing is a worse answer than the outcome you last got.
  const lastDone = latestFinishedActivity(activities);
  return (
    <div className="activity" ref={rootRef}>
      <button
        type="button"
        className="activity-trigger"
        aria-expanded={open}
        aria-haspopup="menu"
        title={projectsTooltip(projects)}
        onClick={() => setOpen((v) => !v)}
      >
        <Summary
          live={live}
          projects={projects}
          waiting={waiting.length}
          lastDone={lastDone}
          currentRootPath={connection.rootPath}
        />
        <span className="caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div className="activity-pop pop" role="menu">
          <div className="pop-head">
            active threads
            <span>
              {/* `0 live` is the footer's claim in miniature — while a project
                  is still being read, the only honest half of this line is how
                  many projects there are. */}
              {everyProjectKnown(projects) ? `${live.length} live · ` : ""}
              {`${projects.length} ${projects.length === 1 ? "project" : "projects"}`}
              {pending.length > 0 ? " · 1 draft" : ""}
            </span>
          </div>

          {projects.map((project) => (
            <ProjectGroup
              key={project.connection.rootPath}
              project={project}
              now={now}
              onOpenProject={props.onOpenProject}
              onOpenSession={({ connection: target, session }) => {
                const id = String(session.id);
                if (target.rootPath === connection.rootPath) select(id);
                else props.onOpenProjectSession?.(target.rootPath, id);
                setOpen(false);
              }}
            />
          ))}

          {/* "Nothing running" is the same claim as `idle` in the trigger, and
              it needs the same evidence: every project's rows say `checking…`
              above it, so asserting the negative here would contradict them. */}
          {live.length === 0 &&
            pending.length === 0 &&
            everyProjectKnown(projects) && (
              <p className="pop-empty">
                Nothing running. <kbd>⌘N</kbd> starts a thread.
              </p>
            )}

          {pending.length > 0 && (
            <>
              <div className="pop-sep" role="presentation" />
              <button
                type="button"
                className="pop-row"
                onClick={() => {
                  newSession();
                  setOpen(false);
                }}
              >
                <span className="dot dot-draft" aria-hidden="true" />
                <span className="pop-row-title">{pending}</span>
                <span className="pop-row-meta">not dispatched</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** The collapsed trigger's one line. Exported so its branches can be read. */
export function Summary(props: {
  live: readonly ProjectActivity[];
  projects: readonly ProjectProgress[];
  waiting: number;
  lastDone: ProjectActivity | undefined;
  currentRootPath: string;
}): ReactNode {
  const { live, projects, waiting, lastDone, currentRootPath } = props;
  const busy = busyProjects(projects);

  if (waiting > 0) {
    const first = live.find(({ session }) => session.status === "waiting");
    return (
      <>
        <StatusGlyph status="waiting" />
        <span className="activity-text">
          {waiting === 1
            ? `${first?.session.title ?? "A thread"}${
                first !== undefined && first.connection.rootPath !== currentRootPath
                  ? ` · ${first.connection.name}`
                  : ""
              }, waiting on you`
            : `${waiting} threads waiting on you`}
        </span>
      </>
    );
  }
  if (live.length === 1) {
    const activity = live[0]!;
    return (
      <>
        <StatusGlyph status="running" />
        <span className="activity-text">
          {activity.session.title ?? activity.session.name}
          {activity.connection.rootPath !== currentRootPath
            ? ` · ${activity.connection.name}`
            : ""}
        </span>
      </>
    );
  }
  if (live.length > 1) {
    return (
      <>
        <StatusGlyph status="running" />
        <span className="activity-text">
          {busy.length > 1
            ? projectTally(projects, TRIGGER_PROJECTS)
            : `${live.length} threads running`}
        </span>
      </>
    );
  }
  // Nothing live and nothing finished can mean two things, and only one of
  // them is idle. Until every loaded project has answered, say so.
  if (lastDone === undefined && !everyProjectKnown(projects)) {
    return (
      <>
        <StatusGlyph status="other" />
        <span className="activity-text">Checking…</span>
      </>
    );
  }
  if (lastDone !== undefined) {
    return (
      <>
        <StatusGlyph status={lastDone.session.status} />
        <span className="activity-text">
          {lastDone.session.status === "completed"
            ? "Last thread finished"
            : `Last thread ${lastDone.session.status}`}
          {" · "}
          {lastDone.session.title ?? lastDone.session.name}
          {lastDone.connection.rootPath !== currentRootPath
            ? ` · ${lastDone.connection.name}`
            : ""}
        </span>
      </>
    );
  }
  return (
    <>
      <StatusGlyph status="other" />
      <span className="activity-text">Idle</span>
    </>
  );
}

/**
 * One loaded project: its own progress line, then its live runs.
 *
 * The header is the switch into that project, so the menu that told you a
 * sibling project is blocked is also the way to go answer it.
 */
export function ProjectGroup(props: {
  project: ProjectProgress;
  now: number;
  onOpenProject: ((rootPath: string) => void) | undefined;
  onOpenSession(activity: ProjectActivity): void;
}): ReactNode {
  const { project } = props;
  const switchable = !project.current && props.onOpenProject !== undefined;

  return (
    <section className={`pop-project${project.current ? " is-current" : ""}`}>
      <button
        type="button"
        className="pop-project-head"
        disabled={!switchable}
        title={switchable ? `Switch to ${project.connection.name}` : undefined}
        onClick={() => props.onOpenProject?.(project.connection.rootPath)}
      >
        <span className="pop-project-name">{project.connection.name}</span>
        {project.current && <span className="pop-project-here">here</span>}
        <span className="pop-row-meta">{projectStatusLabel(project)}</span>
      </button>

      {project.live.map((activity) => (
        <ActivityRow
          key={String(activity.session.id)}
          activity={activity}
          now={props.now}
          inCurrentProject={project.current}
          onOpen={props.onOpenSession}
        />
      ))}

      {/* The body line answers "what happened last", which a project that has
          not answered yet has no answer to — and the header already says
          `checking…` beside its shimmering track. Printing it twice reads as a
          stutter rather than as two facts. */}
      {project.live.length === 0 && project.known && (
        <p className="pop-project-quiet">
          {project.lastDone === undefined
            ? "no threads yet"
            : `last thread ${project.lastDone.session.status} · ${
                project.lastDone.session.title ?? project.lastDone.session.name
              }${
                project.lastDone.session.endedAt === null
                  ? ""
                  : ` · ${fmtAgo(project.lastDone.session.endedAt)}`
              }`}
        </p>
      )}
    </section>
  );
}

/**
 * `inCurrentProject` rather than a root path to compare: only the workspace's
 * own project has a selected run, so a sibling project's row can never be the
 * one you are looking at, however its ids happen to collide.
 */
function ActivityRow(props: {
  activity: ProjectActivity;
  now: number;
  inCurrentProject: boolean;
  onOpen(activity: ProjectActivity): void;
}): ReactNode {
  const { selected } = useHarness();
  const { connection, session } = props.activity;
  const id = session.id as string;
  const api = useMemo(
    () => new ApiClient({ baseUrl: connection.url, token: connection.token }),
    [connection.token, connection.url],
  );

  // Stopping another project's thread is destructive, fires from a popover
  // that is about to close, and used to discard its own failure. A refusal
  // that nobody prints reads exactly like a thread ignoring you.
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const stop = useCallback(() => {
    setStopping(true);
    setStopError(null);
    api
      .stop(id)
      .catch((cause: unknown) => {
        const detail = cause instanceof ApiError ? cause.detail : undefined;
        setStopError(detail ?? `could not stop ${session.name}`);
      })
      .finally(() => setStopping(false));
  }, [api, id, session.name]);

  return (
    <div
      className={`pop-run${
        props.inCurrentProject && id === selected ? " is-current" : ""
      }`}
      role="presentation"
    >
      <button
        type="button"
        className="pop-run-main"
        title={`${session.title ?? session.name} · ${session.status}`}
        onClick={() => props.onOpen(props.activity)}
      >
        <span className="pop-run-top">
          <span className="pop-row-title">{session.title ?? session.name}</span>
          <span className="pop-row-meta">
            {fmtElapsed(elapsedMs(session, props.now))}
          </span>
        </span>
        <span className="pop-run-bottom">
          <span className="pop-row-meta">
            {session.status === "waiting" ? "blocked on you · " : ""}
            {session.name}
          </span>
        </span>
      </button>
      <button
        type="button"
        className="pop-stop"
        title={`Stop ${session.name}`}
        aria-label={`Stop ${session.name}`}
        onClick={stop}
        disabled={stopping}
        aria-busy={stopping}
      >
        {/* The drawn glyph, not the ■ character — a text glyph takes the row's
            font metrics and drifts off optical centre; the SVG is the same
            mark the composer's stop wears. */}
        <StopIcon />
      </button>
      {stopError !== null && (
        <p className="pop-run-error" role="alert">
          {stopError}
        </p>
      )}
    </div>
  );
}
