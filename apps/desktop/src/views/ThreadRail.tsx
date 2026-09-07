/**
 * The sidebar in Agent mode: the master thread, then the runs that forked from
 * it.
 *
 * The master thread is a card and the runs are a list because they are not
 * peers. Every run *came from* the thread above it, and a flat list of five
 * equal rows hides the one relationship that explains the other four. Live
 * runs sort above finished ones for the same reason the old rail did: work
 * blocked on you outranks work that is proceeding fine.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { sessionActivityAt, type SessionRecord } from "@daydream-code/shared";
import { useHarness } from "../harness.js";
import { bridge } from "../bridge.js";
import { useMaster, clip, lede } from "../master.js";
import { stageHandoff } from "../handoff.js";
import {
  NEW_SESSION_DRAFT,
  draftPreview,
  useDrafts,
  type Draft,
} from "../drafts.js";
import { StatusGlyph, compact, fmtAgo, fmtTime, messageText } from "../ui.js";
import {
  RAIL_PAGE,
  isArchived,
  isLive,
  railSessions,
  useSessionActions,
  useSessions,
} from "../sessions.js";
import { useActivities, type Activity } from "../replies.js";

/** The one-line facts under a run's title: model, then what it has spent. */
function runFacts(session: SessionRecord, model: string): string[] {
  const { usage } = session;
  const facts = [model];
  const tokens = usage.tokensIn + usage.tokensOut;
  if (tokens > 0) facts.push(compact(tokens));
  if (usage.costUsd > 0) facts.push(`$${usage.costUsd.toFixed(2)}`);
  return facts;
}

export function ThreadRail(): ReactNode {
  const {
    selected,
    select,
    split,
    toggleSplit,
    closeSplit,
    draft,
    newSession,
    drafts: draftStore,
    modelLabel,
    setOverlay,
  } = useHarness();
  const { sessions, loading, error: listError } = useSessions();
  const { entries } = useMaster();
  // What each run did most recently: replies, tool calls, questions and other
  // meaningful journal activity all share this one live map.
  const activities = useActivities();
  // Unsent text is invisible once you navigate away from it, so the rail is
  // where it has to show up: a row you owe something to should say so.
  const drafts = useDrafts(draftStore);

  // How far down the finished runs the person has asked to see. Reset is
  // deliberate on project switch only — paging back up every time a session
  // finishes would undo the reading position while they are still in it.
  const [shown, setShown] = useState(RAIL_PAGE);
  // A rail line rather than a toast: a message about work that did not happen
  // should not time out before it is read.
  const { setArchived, remove, failure } = useSessionActions();

  // A thread deleted out from under the second pane must not leave a dead
  // transcript there. Master (`id: null`) always exists, and a list that has
  // not loaded — or failed to — proves nothing about what does.
  useEffect(() => {
    if (split === null || split.id === null || loading || listError !== null)
      return;
    if (!sessions.some((s) => (s.id as string) === split.id)) closeSplit();
  }, [split, sessions, loading, listError, closeSplit]);

  const { live, finished, more, archived } = useMemo(
    () => railSessions(sessions, { shown }),
    [sessions, shown],
  );
  const waiting = live.filter((s) => s.status === "waiting");

  /**
   * The platform menu for one run, and whatever it chose.
   *
   * Archiving and deleting go straight to the server rather than updating a
   * local copy first: both come back as stream frames, and an optimistic
   * removal that the server then refused would leave the rail disagreeing with
   * the project about which runs exist.
   */
  const openMenu = useCallback(
    async (session: SessionRecord) => {
      const app = bridge();
      if (app === undefined) return;
      const id = session.id as string;
      const action = await app.showSessionContextMenu({
        id,
        name: session.name,
        archived: isArchived(session),
        live: isLive(session),
        current: id === selected,
      });
      if (action === null) return;
      if (action === "open") {
        select(id);
        return;
      }
      if (action === "handoff" || action === "summarize") {
        // Stage first, then open: the sheet reads the slot once on mount.
        stageHandoff(session, action === "handoff" ? "transcript" : "summary");
        setOverlay("handoff");
        return;
      }
      if (action === "delete") await remove(session);
      else await setArchived(session, action === "archive");
    },
    [selected, select, remove, setArchived, setOverlay],
  );

  /**
   * Shift+click puts a thread beside the current one instead of replacing it.
   * The thread already filling the first pane is the one thing there is no
   * point splitting with, so that shift+click falls through to a plain select.
   */
  const openSplit = useCallback(
    (id: string | null) => {
      if (id === selected) select(id);
      else toggleSplit(id);
    },
    [selected, select, toggleSplit],
  );

  const row = useCallback(
    (session: SessionRecord) => {
      const model = modelLabel(session.driver, session.modelId);
      return (
        <RunCard
          key={session.id as string}
          session={session}
          current={(session.id as string) === selected}
          inSplit={split !== null && split.id === (session.id as string)}
          model={model.label}
          draft={drafts.get(session.id as string)}
          activity={activities.get(session.id as string)}
          onSelect={select}
          onSplit={openSplit}
          onMenu={openMenu}
        />
      );
    },
    [selected, select, split, openSplit, drafts, activities, modelLabel, openMenu],
  );

  const last = entries?.[entries.length - 1];
  const pending = draftPreview(drafts.get(NEW_SESSION_DRAFT));
  // A count is a claim. Until the list has been read there is no number to
  // report, and "0 threads" is the wrong thing to say about a project whose
  // threads simply have not arrived yet.
  const railSummary =
    loading || listError !== null
      ? null
      : waiting.length > 0
        ? `${waiting.length} waiting on you`
        : live.length > 0
          ? `${live.length} running`
          : `${sessions.length} thread${sessions.length === 1 ? "" : "s"}`;
  const masterSummary =
    last !== undefined
      ? messageText(last.message).replace(/\s+/g, " ").trim()
      : entries === null
        ? ""
        : "Nothing on the thread yet.";
  const masterTitle = lede(masterSummary);
  // The spawned count is a second claim on a second list, so it waits for that
  // list rather than reporting the zero it starts at.
  const spawned =
    loading || listError !== null ? "" : ` · ${sessions.length} spawned`;
  const masterMeta =
    entries === null
      ? "loading…"
      : `${entries.length} ${entries.length === 1 ? "entry" : "entries"}${spawned}`;

  return (
    <div className="rail">
      <header className="rail-head">
        threads
        {railSummary !== null && (
          <span key={railSummary} className="rail-count sidebar-change">
            {railSummary}
          </span>
        )}
        <button
          type="button"
          className="rail-add"
          onClick={newSession}
          aria-label="New thread"
          title="New thread (⌘N)"
        >
          +
        </button>
      </header>

      <button
        type="button"
        className="master-card"
        onClick={(event) =>
          event.shiftKey ? openSplit(null) : select(null)
        }
      >
        <span className="master-card-top">
          <span className="master-card-mark" aria-hidden="true">
            ◈
          </span>
          <span className="master-card-label">master thread</span>
          <span
            key={last?.createdAt ?? "empty"}
            className="master-card-time sidebar-change"
          >
            {last !== undefined ? fmtTime(last.createdAt) : ""}
          </span>
        </span>
        {/* The thread has no subject line of its own, so the newest entry is
            the honest answer to "what is this about now". */}
        <span
          key={masterTitle}
          className="master-card-title sidebar-change"
          title={masterSummary}
        >
          {masterTitle}
        </span>
        <span key={masterMeta} className="master-card-meta sidebar-change">
          {masterMeta}
        </span>
      </button>

      <div className="rail-label">active threads</div>

      {loading && (
        <div className="runs" aria-busy="true">
          <div className="skeleton skeleton-card" />
          <div className="skeleton skeleton-card" style={{ opacity: 0.6 }} />
          <div className="skeleton skeleton-card" style={{ opacity: 0.3 }} />
        </div>
      )}

      {listError !== null && (
        <p className="rail-error" role="alert">
          {listError}
        </p>
      )}

      {!loading &&
        listError === null &&
        sessions.length === 0 &&
        !draft &&
        pending.length === 0 && (
          <p className="rail-empty">
            No threads yet. Press <kbd>+</kbd> to start one; it forks the master
            thread at its current state.
          </p>
        )}
      {!loading && (sessions.length > 0 || draft || pending.length > 0) && (
        <div className="runs">
          {/* The row outlives the view: an undispatched task you clicked away
              from still has to be somewhere you can see and get back to. */}
          {(draft || pending.length > 0) && (
            <button
              type="button"
              className="run-card run-card-draft"
              aria-current={draft || undefined}
              onClick={newSession}
            >
              {/* The one card that keeps a word beside its mark: a draft has
                  no status to glyph and nothing to quote back, so "draft" is
                  the only thing naming it. */}
              <span className="run-card-top">
                <span className="dot dot-draft" aria-hidden="true" />
                <span className="run-card-label">draft</span>
                <span className="run-card-time">—</span>
              </span>
              <span className="run-card-said">
                {pending.length > 0 ? pending : "New thread"}
              </span>
              <span className="run-card-facts">not dispatched yet</span>
            </button>
          )}
          {live.map(row)}
          {live.length > 0 && finished.length > 0 && (
            <div
              className="rail-divider sidebar-element-in"
              role="presentation"
            />
          )}
          {finished.map(row)}

          {/* Counted, not just offered: "Show 62 more" says how long the list
              actually is, which is the fact that decides whether you want it. */}
          {more > 0 && (
            <button
              type="button"
              className="rail-more"
              onClick={() => setShown((n) => n + RAIL_PAGE)}
            >
              Show {Math.min(more, RAIL_PAGE)} more
              <span className="rail-more-count">{more} older</span>
            </button>
          )}

          {/* A door, not a drawer. An archived run has been taken off this
              list on purpose, and expanding it back into place here would
              undo the only thing archiving does. */}
          {archived.length > 0 && (
            <>
              <div className="rail-divider" role="presentation" />
              <button
                type="button"
                className="rail-more"
                onClick={() => setOverlay("archive")}
              >
                Archived…
                <span className="rail-more-count">{archived.length}</span>
              </button>
            </>
          )}
        </div>
      )}

      {failure !== null && (
        <p className="rail-error" role="alert">
          {failure}
        </p>
      )}
    </div>
  );
}

/**
 * Status is the glyph, not a word.
 *
 * The word repeated the glyph beside it on every row and then took the line
 * the title wanted, which is how a list of five runs ended up saying RUNNING
 * three times and naming nothing. The glyph carries state (it animates while
 * the run works), the line beside it carries identity, and the line under it
 * is the latest meaningful activity.
 */
function RunCard(props: {
  session: SessionRecord;
  current: boolean;
  /** Whether this thread is the one shown in the second pane. */
  inSplit: boolean;
  model: string;
  /** Unsent composer contents for this session, if there are any. */
  draft: Draft | undefined;
  /** Its latest meaningful journal activity, once one has been seen. */
  activity: Activity | undefined;
  onSelect(id: string): void;
  onSplit(id: string): void;
  onMenu(session: SessionRecord): void;
}): ReactNode {
  const { session, current, model } = props;
  const id = session.id as string;
  const preview = draftPreview(props.draft);
  // `tldr` is the write-back at session end, so it stands in for runs that
  // finished before the bounded activity window. A run that has neither gets
  // no line at all rather than a husk.
  const activity = props.activity;
  const summary = activity?.text ?? session.tldr ?? "";
  const said = clip(summary, 200);
  const activityLabel = activity?.label ?? (said.length > 0 ? "reply" : "");
  const title = session.title ?? session.name;
  const age = fmtAgo(sessionActivityAt(session));
  const facts = runFacts(session, model);

  const archived = isArchived(session);

  return (
    <button
      type="button"
      className={`run-card run-${session.status}${archived ? " run-card-archived" : ""}${
        props.inSplit ? " run-card-in-split" : ""
      }`}
      aria-current={current || props.inSplit || undefined}
      title={`${session.name} · ${session.status} · ${session.driver}${
        archived ? " · archived" : ""
      }${
        preview.length > 0 ? `\nunsent draft: ${preview}` : ""
      }\nshift+click opens it beside the current thread`}
      onClick={(event) =>
        event.shiftKey ? props.onSplit(id) : props.onSelect(id)
      }
      onContextMenu={(event) => {
        // Without a bridge (the browser dev server) let the default menu
        // through rather than swallowing the event for a menu that cannot open.
        if (bridge() === undefined) return;
        event.preventDefault();
        props.onMenu(session);
      }}
    >
      <span className="run-card-top">
        <span
          key={session.status}
          className="sidebar-glyph-change sidebar-change"
        >
          <StatusGlyph status={session.status} />
        </span>
        <span
          key={title}
          className="run-card-name sidebar-change"
          title={title}
        >
          {title}
        </span>
        <span key={age} className="run-card-time sidebar-change">
          {age}
        </span>
      </span>
      {said.length > 0 && (
        <span
          key={`${activity?.eventId ?? "tldr"}:${activityLabel}:${said}`}
          className={`run-card-said run-card-activity-${activity?.kind ?? "reply"} sidebar-change`}
          title={summary}
        >
          <span className="run-card-activity-label">{activityLabel}</span>
          {said}
        </span>
      )}
      {/* Unsent text displaces the facts: a run you owe a message to is not
          asking to be told what it cost. */}
      {preview.length > 0 ? (
        <span className="run-card-facts">
          <span className="row-draft">draft</span>
          {preview}
        </span>
      ) : (
        <span
          key={facts.join("\u0000")}
          className="run-card-facts sidebar-change"
        >
          {facts.map((fact) => (
            <span key={fact}>{fact}</span>
          ))}
        </span>
      )}
    </button>
  );
}
