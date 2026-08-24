/**
 * Every session in the open project, kept live off the websocket.
 *
 * Its own module because four surfaces read it — the rail, the toolbar's
 * activity menu, the command palette and the master timeline — and none of
 * them should own the list the others depend on.
 */
import { useEffect, useMemo, useState } from "react";
import { compareSessionRecency, type SessionRecord } from "@daydream-code/shared";
import { useHarness } from "./harness.js";

export function useSessions(): {
  sessions: SessionRecord[];
  loading: boolean;
} {
  const { api, subscribe, resyncTick } = useHarness();
  const [sessions, setSessions] = useState<SessionRecord[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .sessions()
      .then((list) => {
        if (!cancelled) setSessions(list);
      })
      .catch(() => {
        if (!cancelled) setSessions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api, resyncTick]);

  useEffect(
    () =>
      subscribe((frame) => {
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

  return { sessions: sessions ?? [], loading: sessions === null };
}

/** Still in flight: the driver process is up and the row must not be reaped. */
export function isLive(session: SessionRecord): boolean {
  return session.status === "running" || session.status === "waiting";
}

/**
 * The live runs, blocked-on-you first.
 *
 * `waiting` outranks `running` everywhere this order is used: both are live,
 * but only one of them cannot proceed without the person reading the screen.
 */
export function useLiveSessions(): SessionRecord[] {
  const { sessions } = useSessions();
  return useMemo(() => {
    const byRecency = [...sessions].sort(compareSessionRecency);
    return [
      ...byRecency.filter((s) => s.status === "waiting"),
      ...byRecency.filter((s) => s.status === "running"),
    ];
  }, [sessions]);
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
