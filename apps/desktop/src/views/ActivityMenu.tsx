/**
 * The toolbar's centre: what the harness is doing right now, and a menu of the
 * runs doing it.
 *
 * A window that can have six agents working in it needs one place that answers
 * "is anything happening" without reading a sidebar. The collapsed button is
 * that answer; the menu is the way into whichever run the answer was about.
 *
 * The bars are indeterminate on purpose. A run has no total — the model
 * decides when it is done — so a percentage would be a number the harness
 * invented. A sweep says "working" without claiming to know how much is left.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { SessionRecord } from "@daydream-code/shared";
import { useHarness } from "../harness.js";
import { elapsedMs, fmtElapsed, useLiveSessions, useSessions } from "../sessions.js";
import { NEW_SESSION_DRAFT, draftPreview, useDrafts } from "../drafts.js";
import { StatusGlyph } from "../ui.js";

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

export function ActivityMenu(): ReactNode {
  const { select, newSession, drafts: draftStore } = useHarness();
  const { sessions } = useSessions();
  const live = useLiveSessions();
  const drafts = useDrafts(draftStore);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const now = useTicker(live.length > 0);

  useDismiss(rootRef, open, () => setOpen(false));

  const waiting = live.filter((s) => s.status === "waiting");
  const pending = draftPreview(drafts.get(NEW_SESSION_DRAFT));
  // The last run to finish is what "idle" should report on — an empty bar that
  // says nothing is a worse answer than the outcome you last got.
  const lastDone = sessions
    .filter((s) => s.endedAt !== null)
    .sort((a, b) => (a.endedAt! < b.endedAt! ? 1 : -1))[0];

  return (
    <div className="activity" ref={rootRef}>
      <button
        type="button"
        className="activity-trigger"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
      >
        <Summary live={live} waiting={waiting.length} lastDone={lastDone} />
        <span className="activity-bars" aria-hidden="true">
          {live.slice(0, 3).map((session) => (
            <span
              key={session.id as string}
              className={`mini-bar mini-${session.status}`}
            />
          ))}
        </span>
        <span className="caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div className="activity-pop pop" role="menu">
          <div className="pop-head">
            active agents
            <span>
              {live.length} live
              {pending.length > 0 ? " · 1 draft" : ""}
            </span>
          </div>

          {live.length === 0 && pending.length === 0 && (
            <p className="pop-empty">
              Nothing running. <kbd>⌘N</kbd> starts a run.
            </p>
          )}

          {live.map((session) => (
            <ActivityRow
              key={session.id as string}
              session={session}
              now={now}
              onOpen={(id) => {
                select(id);
                setOpen(false);
              }}
            />
          ))}

          {pending.length > 0 && (
            <>
              {live.length > 0 && <div className="pop-sep" role="presentation" />}
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

function Summary(props: {
  live: readonly SessionRecord[];
  waiting: number;
  lastDone: SessionRecord | undefined;
}): ReactNode {
  const { live, waiting, lastDone } = props;

  if (waiting > 0) {
    return (
      <>
        <StatusGlyph status="waiting" />
        <span className="activity-text">
          {waiting === 1
            ? `${live.find((s) => s.status === "waiting")?.title ?? "A run"} — waiting on you`
            : `${waiting} runs waiting on you`}
        </span>
      </>
    );
  }
  if (live.length === 1) {
    return (
      <>
        <StatusGlyph status="running" />
        <span className="activity-text">{live[0]!.title ?? live[0]!.name}</span>
      </>
    );
  }
  if (live.length > 1) {
    return (
      <>
        <StatusGlyph status="running" />
        <span className="activity-text">{live.length} agents running</span>
      </>
    );
  }
  if (lastDone !== undefined) {
    return (
      <>
        <StatusGlyph status={lastDone.status} />
        <span className="activity-text">
          {lastDone.status === "completed" ? "Last run finished" : `Last run ${lastDone.status}`}
          {" · "}
          {lastDone.title ?? lastDone.name}
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

function ActivityRow(props: {
  session: SessionRecord;
  now: number;
  onOpen(id: string): void;
}): ReactNode {
  const { api, selected } = useHarness();
  const { session } = props;
  const id = session.id as string;

  return (
    <div
      className={`pop-run${id === selected ? " is-current" : ""}`}
      role="presentation"
    >
      <button type="button" className="pop-run-main" onClick={() => props.onOpen(id)}>
        <span className="pop-run-top">
          <StatusGlyph status={session.status} />
          <span className="pop-row-title">{session.title ?? session.name}</span>
          <span className="pop-row-meta">
            {fmtElapsed(elapsedMs(session, props.now))}
          </span>
        </span>
        <span className="pop-run-bottom">
          <span className={`sweep sweep-${session.status}`} aria-hidden="true">
            <i />
          </span>
          <span className="pop-row-meta">
            {session.status === "waiting" ? "blocked on you" : session.name}
          </span>
        </span>
      </button>
      <button
        type="button"
        className="pop-stop"
        title={`Stop ${session.name}`}
        aria-label={`Stop ${session.name}`}
        onClick={() => void api.stop(id).catch(() => undefined)}
      >
        ■
      </button>
    </div>
  );
}

/** Close on an outside click or Escape — the two ways a Mac menu goes away. */
export function useDismiss(
  ref: React.RefObject<HTMLElement | null>,
  open: boolean,
  close: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      if (!ref.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [ref, open, close]);
}
