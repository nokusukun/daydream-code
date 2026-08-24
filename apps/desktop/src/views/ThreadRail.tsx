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
import { useCallback, useMemo, type ReactNode } from "react";
import {
  compareSessionRecency,
  sessionActivityAt,
  type SessionRecord,
} from "@daydream-code/shared";
import { useHarness } from "../harness.js";
import { useMaster, clip, lede } from "../master.js";
import {
  NEW_SESSION_DRAFT,
  draftPreview,
  useDrafts,
  type Draft,
} from "../drafts.js";
import { StatusGlyph, fmtAgo, fmtTime, messageText } from "../ui.js";
import { useSessions } from "../sessions.js";
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

/** 56.6k — a rail row has space for a number, not for six digits. */
export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}m`;
}

export function ThreadRail(): ReactNode {
  const { selected, select, draft, newSession, drafts: draftStore, modelLabel } =
    useHarness();
  const { sessions, loading } = useSessions();
  const { entries } = useMaster();
  // What each run did most recently: replies, tool calls, questions and other
  // meaningful journal activity all share this one live map.
  const activities = useActivities();
  // Unsent text is invisible once you navigate away from it, so the rail is
  // where it has to show up: a row you owe something to should say so.
  const drafts = useDrafts(draftStore);

  const [live, finished, waiting] = useMemo(() => {
    const byRecency = [...sessions].sort(compareSessionRecency);
    const isLive = (s: SessionRecord) =>
      s.status === "running" || s.status === "waiting";
    return [
      [
        ...byRecency.filter((s) => s.status === "waiting"),
        ...byRecency.filter((s) => s.status === "running"),
      ],
      byRecency.filter((s) => !isLive(s)),
      byRecency.filter((s) => s.status === "waiting"),
    ];
  }, [sessions]);

  const row = useCallback(
    (session: SessionRecord) => {
      const model = modelLabel(session.driver, session.modelId);
      return (
        <RunCard
          key={session.id as string}
          session={session}
          current={(session.id as string) === selected}
          model={model.label}
          draft={drafts.get(session.id as string)}
          activity={activities.get(session.id as string)}
          onSelect={select}
        />
      );
    },
    [selected, select, drafts, activities, modelLabel],
  );

  const last = entries?.[entries.length - 1];
  const pending = draftPreview(drafts.get(NEW_SESSION_DRAFT));
  const railSummary =
    waiting.length > 0
      ? `${waiting.length} waiting on you`
      : live.length > 0
        ? `${live.length} running`
        : `${sessions.length} run${sessions.length === 1 ? "" : "s"}`;
  const masterTitle =
    last !== undefined
      ? lede(messageText(last.message).replace(/\s+/g, " ").trim())
      : "Nothing on the thread yet.";
  const masterMeta =
    entries === null
      ? "loading…"
      : `${entries.length} ${entries.length === 1 ? "entry" : "entries"} · ${sessions.length} spawned`;

  return (
    <div className="rail">
      <header className="rail-head">
        thread
        <span key={railSummary} className="rail-count sidebar-change">
          {railSummary}
        </span>
        <button
          type="button"
          className="rail-add"
          onClick={newSession}
          aria-label="New session"
          title="New session (⌘N)"
        >
          +
        </button>
      </header>

      <button
        type="button"
        className="master-card"
        onClick={() => select(null)}
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
        <span key={masterTitle} className="master-card-title sidebar-change">
          {masterTitle}
        </span>
        <span key={masterMeta} className="master-card-meta sidebar-change">
          {masterMeta}
        </span>
      </button>

      <div className="rail-label">spawned runs</div>

      {loading && (
        <div className="runs" aria-busy="true">
          <div className="skeleton skeleton-card" />
          <div className="skeleton skeleton-card" style={{ opacity: 0.6 }} />
          <div className="skeleton skeleton-card" style={{ opacity: 0.3 }} />
        </div>
      )}

      {!loading && sessions.length === 0 && !draft && pending.length === 0 && (
        <p className="rail-empty">
          No runs yet. Press <kbd>+</kbd> to start one; it forks the master
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
              aria-current={draft}
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
                {pending.length > 0 ? pending : "New session"}
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
        </div>
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
  model: string;
  /** Unsent composer contents for this session, if there are any. */
  draft: Draft | undefined;
  /** Its latest meaningful journal activity, once one has been seen. */
  activity: Activity | undefined;
  onSelect(id: string): void;
}): ReactNode {
  const { session, current, model } = props;
  const id = session.id as string;
  const preview = draftPreview(props.draft);
  // `tldr` is the write-back at session end, so it stands in for runs that
  // finished before the bounded activity window. A run that has neither gets
  // no line at all rather than a husk.
  const activity = props.activity;
  const said = clip(activity?.text ?? session.tldr ?? "", 200);
  const activityLabel = activity?.label ?? (said.length > 0 ? "reply" : "");
  const title = session.title ?? session.name;
  const age = fmtAgo(sessionActivityAt(session));
  const facts = runFacts(session, model);

  return (
    <button
      type="button"
      className={`run-card run-${session.status}`}
      aria-current={current}
      title={`${session.name} · ${session.status} · ${session.driver}${
        preview.length > 0 ? `\nunsent draft: ${preview}` : ""
      }`}
      onClick={() => props.onSelect(id)}
    >
      <span className="run-card-top">
        <span
          key={session.status}
          className="sidebar-glyph-change sidebar-change"
        >
          <StatusGlyph status={session.status} />
        </span>
        <span key={title} className="run-card-name sidebar-change">
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
