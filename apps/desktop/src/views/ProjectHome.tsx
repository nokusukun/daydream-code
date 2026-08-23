/**
 * Project home: the master-thread timeline (live context by default, full
 * history on toggle) with the dispatch composer pinned at the bottom.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { SessionRecord, ThreadEntry } from "@daydream-code/shared";
import { useHarness } from "../harness.js";
import { SplitPane } from "../split.js";
import { Badge, SessionLink, StatusPill, fmtTime, messageText } from "../ui.js";

const DRIVERS = ["claude", "codex", "mock"] as const;

export function ProjectHome(): ReactNode {
  const { api, subscribe, resyncTick, navigate } = useHarness();
  const [showAll, setShowAll] = useState(false);
  const [entries, setEntries] = useState<ThreadEntry[]>([]);
  const [sessions, setSessions] = useState<Map<string, SessionRecord>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    api
      .master(showAll)
      .then(setEntries)
      .catch((e: unknown) => setError(String(e)));
    api
      .sessions()
      .then((list) => setSessions(new Map(list.map((s) => [s.id as string, s]))))
      .catch(() => undefined);
  }, [api, showAll]);

  useEffect(refetch, [refetch, resyncTick]);

  useEffect(
    () =>
      subscribe((frame) => {
        // Thread entries arrive at dispatch/turn-end cadence — cheap to refetch,
        // and a refetch is the only correct move once a compaction supersedes rows.
        if (frame.kind === "thread") refetch();
        if (frame.kind === "session") {
          setSessions((prev) => {
            const next = new Map(prev);
            next.set(frame.session.id as string, frame.session);
            return next;
          });
        }
      }),
    [subscribe, refetch],
  );

  const feedRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const feed = feedRef.current;
    if (feed !== null) feed.scrollTop = feed.scrollHeight;
  }, [entries]);

  // -- dispatch composer ----------------------------------------------------
  const [task, setTask] = useState("");
  const [driver, setDriver] = useState<string>("claude");
  const [dispatching, setDispatching] = useState(false);
  const [dispatchError, setDispatchError] = useState<string | null>(null);

  const dispatch = useCallback(() => {
    const trimmed = task.trim();
    if (trimmed.length === 0 || dispatching) return;
    setDispatching(true);
    setDispatchError(null);
    api
      .dispatch({ task: trimmed, driver })
      .then((record) => {
        setTask("");
        navigate({ name: "session", id: record.id as string });
      })
      .catch((e: unknown) => setDispatchError(e instanceof Error ? e.message : String(e)))
      .finally(() => setDispatching(false));
  }, [api, task, driver, dispatching, navigate]);

  const openSession = useCallback(
    (id: string) => navigate({ name: "session", id }),
    [navigate],
  );

  return (
    <div className="view view-home">
      <div className="view-toolbar">
        <h2>master thread</h2>
        <label className="toggle">
          <input
            type="checkbox"
            checked={showAll}
            onChange={(e) => setShowAll(e.target.checked)}
          />
          full history
        </label>
        <span className="toolbar-meta">
          {entries.length} entries {showAll ? "(all)" : "(live context)"}
        </span>
      </div>

      {error !== null && <div className="error-bar">{error}</div>}

      <SplitPane
        id="home-composer"
        direction="column"
        initial={150}
        min={104}
        max={520}
        first={
          <div className="feed" ref={feedRef}>
            {entries.length === 0 && (
              <div className="empty">
                Nothing on the master thread yet. Dispatch a session below —
                every dispatch, turn-end and summary lands here as it happens.
              </div>
            )}
            {entries.map((entry) => (
              <TimelineEntry
                key={entry.id}
                entry={entry}
                session={
                  entry.sessionId !== undefined
                    ? sessions.get(entry.sessionId as string)
                    : undefined
                }
                onOpenSession={openSession}
              />
            ))}
          </div>
        }
        second={
          <div className="composer">
            {dispatchError !== null && (
              <div className="error-bar">{dispatchError}</div>
            )}
            <textarea
              value={task}
              placeholder="Describe a task to dispatch…  (ctrl+enter to send)"
              onChange={(e) => setTask(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  dispatch();
                }
              }}
            />
            <div className="composer-row">
              <select value={driver} onChange={(e) => setDriver(e.target.value)}>
                {DRIVERS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="primary"
                disabled={dispatching || task.trim().length === 0}
                onClick={dispatch}
              >
                {dispatching ? "dispatching…" : "dispatch"}
              </button>
            </div>
          </div>
        }
      />
    </div>
  );
}

function TimelineEntry(props: {
  entry: ThreadEntry;
  session: SessionRecord | undefined;
  onOpenSession(id: string): void;
}): ReactNode {
  const { entry, session } = props;
  return (
    <article className={`entry entry-${entry.kind}`}>
      <header className="entry-head">
        <Badge kind={entry.kind} />
        <span className="entry-seq">#{entry.seq}</span>
        {entry.sessionId !== undefined && (
          <SessionLink id={entry.sessionId as string} onOpen={props.onOpenSession} />
        )}
        {session !== undefined && <StatusPill status={session.status} />}
        {entry.toSessionId != null && (
          <span className="entry-target">→ {entry.toSessionId as string}</span>
        )}
        <span className="entry-time">{fmtTime(entry.createdAt)}</span>
      </header>
      <pre className="entry-body">{messageText(entry.message)}</pre>
    </article>
  );
}
