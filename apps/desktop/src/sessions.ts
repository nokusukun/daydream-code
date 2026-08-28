/**
 * Every session in the open project, kept live off the websocket.
 *
 * Its own module because four surfaces read it — the rail, the toolbar's
 * activity menu, the command palette and the master timeline — and none of
 * them should own the list the others depend on.
 */
import { useCallback, useEffect, useState } from "react";
import { compareSessionRecency, type SessionRecord } from "@daydream-code/shared";
import { ApiError } from "./api.js";
import { useHarness } from "./harness.js";

export function useSessions(): {
  sessions: SessionRecord[];
  loading: boolean;
  /** Why the list could not be read, or null. Empty is not a synonym. */
  error: string | null;
} {
  const { api, subscribe, resyncTick } = useHarness();
  const [sessions, setSessions] = useState<SessionRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .sessions()
      .then((list) => {
        if (cancelled) return;
        setError(null);
        setSessions(list);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        // A failed read used to resolve to `[]`, which four surfaces then
        // reported as a project with no runs: the app confidently telling you
        // your work is gone because one fetch failed. The list stays null so
        // nothing downstream can mistake "not read" for "nothing there".
        const detail = cause instanceof ApiError ? cause.detail : undefined;
        setError(detail ?? "could not read this project's threads");
      });
    return () => {
      cancelled = true;
    };
  }, [api, resyncTick]);

  useEffect(
    () =>
      subscribe((frame) => {
        if (frame.kind === "session-deleted") {
          // The only frame that removes. `session` frames are merged by
          // upsert, so a deletion sent on that channel would re-add the row it
          // was meant to retire.
          setSessions((prev) =>
            prev === null ? prev : prev.filter((s) => (s.id as string) !== frame.id),
          );
          return;
        }
        if (frame.kind !== "session") return;
        setSessions((prev) => {
          const next = prev === null ? [] : [...prev];
          const at = next.findIndex((s) => s.id === frame.session.id);
          if (at === -1) next.unshift(frame.session);
          else next[at] = frame.session;
          return next;
        });
      }),
    [subscribe],
  );

  // Loading is "no answer yet", which a failed read is not. Keeping them
  // apart is what lets a consumer show the reason instead of an empty list.
  return { sessions: sessions ?? [], loading: sessions === null && error === null, error };
}

/**
 * Shelved by the person, deliberately.
 *
 * A predicate rather than `archivedAt !== null` at each call site, and it
 * tests for a real timestamp rather than for not-null, because the field
 * arrives over a socket from a core this renderer did not build. Vite reloads
 * the renderer; it cannot reload the harness process behind it, so a running
 * app routinely pairs new UI with a core that predates the column and sends no
 * `archivedAt` at all. `undefined !== null` is true, so the not-null form
 * classified *every* run as archived and emptied the sidebar.
 *
 * `SessionRecord` types this `string | null`, which describes what this build
 * produces — not what is on the wire. Unknown means visible: hiding a run the
 * person never shelved is the expensive mistake, and showing one they did is
 * the cheap one.
 */
export function isArchived(session: SessionRecord): boolean {
  return typeof session.archivedAt === "string" && session.archivedAt.length > 0;
}

/** Still in flight: the driver process is up and the row must not be reaped. */
export function isLive(session: SessionRecord): boolean {
  return session.status === "running" || session.status === "waiting";
}

/** Milliseconds a session has been going, or ran for once it ended. */
export function elapsedMs(session: SessionRecord, now = Date.now()): number {
  const start = new Date(session.startedAt).getTime();
  if (Number.isNaN(start)) return 0;
  const end = session.endedAt === null ? now : new Date(session.endedAt).getTime();
  return Math.max(0, (Number.isNaN(end) ? now : end) - start);
}

/** "4m 12s" — the shape a run's clock takes next to a progress bar. */
export function fmtElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * How many finished runs the rail shows before it stops.
 *
 * A project that has been dogfooded for a week has hundreds of runs, and a
 * list that long stops being a list — you scroll it rather than read it. Live
 * runs are never counted against this: they are the reason the rail exists,
 * and a cap that could push a running session off the bottom would be hiding
 * exactly the thing it should surface.
 */
export const RAIL_PAGE = 50;

export interface RailList {
  /** Live runs, blocked-on-you first. Never truncated. */
  live: SessionRecord[];
  /** Finished runs, most recent first, cut to `shown`. */
  finished: SessionRecord[];
  /** Finished runs past the cut — what "Show more" would reveal. */
  more: number;
  /**
   * Shelved runs, most recent first. The rail never draws these; they belong
   * to the archive window, which is the whole point of shelving one.
   */
  archived: SessionRecord[];
}

/**
 * The lists the rail draws, plus the shelf it deliberately does not.
 *
 * Nothing is ever archived by this function or by anything downstream of it:
 * `more` hides old runs behind one click and keeps them exactly where they
 * were. Archiving is a thing a person does to one run on purpose, and it is
 * the only way a run leaves this list.
 *
 * Liveness outranks the shelf: a row that is somehow both live and archived —
 * a crash left the flag behind — is shown in the rail, because being wrong in
 * the direction of visibility is the cheap mistake.
 */
export function railSessions(
  sessions: readonly SessionRecord[],
  options: { shown?: number } = {},
): RailList {
  const shown = Math.max(0, options.shown ?? RAIL_PAGE);
  const byRecency = [...sessions].sort(compareSessionRecency);
  const live = byRecency.filter(isLive);
  const rest = byRecency.filter((s) => !isLive(s));
  const finished = rest.filter((s) => !isArchived(s));
  return {
    live: [
      ...live.filter((s) => s.status === "waiting"),
      ...live.filter((s) => s.status !== "waiting"),
    ],
    finished: finished.slice(0, shown),
    more: Math.max(0, finished.length - shown),
    archived: rest.filter(isArchived),
  };
}

export interface SessionActions {
  /** Shelve a run or put it back. False means the server refused. */
  setArchived(session: SessionRecord, archived: boolean): Promise<boolean>;
  /** Erase a run. False means the server refused. */
  remove(session: SessionRecord): Promise<boolean>;
  /** The last refusal, or null. Cleared when the next action starts. */
  failure: string | null;
}

/**
 * Archive and delete, shared by the rail's context menu and the archive window.
 *
 * One hook rather than two copies because the interesting parts are not the
 * two fetches: they are dropping the deleted run's unsent draft, moving off it
 * if it was the open panel, and turning a refusal into a sentence. A second
 * copy would be a second place for one of those to be forgotten.
 *
 * Nothing here updates a local list. Both calls come back as stream frames, and
 * an optimistic removal the server then refused would leave the window
 * disagreeing with the project about which runs exist.
 */
export function useSessionActions(): SessionActions {
  const { api, drafts, selected, select } = useHarness();
  const [failure, setFailure] = useState<string | null>(null);

  const guard = useCallback(
    async (verb: string, session: SessionRecord, run: () => Promise<unknown>) => {
      setFailure(null);
      try {
        await run();
        return true;
      } catch (error) {
        // The server's sentence already names the run and the remedy; the
        // request path in front of it is for a log, not for a person.
        const detail = error instanceof ApiError ? error.detail : undefined;
        setFailure(detail ?? `could not ${verb} ${session.name}`);
        return false;
      }
    },
    [],
  );

  const setArchived = useCallback(
    (session: SessionRecord, archived: boolean) =>
      guard(archived ? "archive" : "restore", session, () =>
        api.archive(session.id as string, archived),
      ),
    [api, guard],
  );

  const remove = useCallback(
    (session: SessionRecord) =>
      guard("delete", session, async () => {
        const id = session.id as string;
        await api.remove(id);
        // Unsent composer text outlives the panel, so it has to be dropped
        // explicitly or it becomes a draft for a run that no longer exists.
        drafts.clear(id);
        if (selected === id) select(null);
      }),
    [api, drafts, guard, selected, select],
  );

  return { setArchived, remove, failure };
}
