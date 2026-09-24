/**
 * A card's thread, shown for as long as the card is held.
 *
 * Read-only on purpose. Opening the thread is a click away and moves you out
 * of the board; a peek is for "what is that one doing" without leaving it, so
 * there is no composer, no tabs and no focus change — nothing a person has to
 * put back when they let go. It still reads live off the socket, because the
 * card most worth peeking at is the one that is running right now.
 *
 * Rendered through a portal: the board's lanes scroll and clip, and a peek
 * trapped inside its card's lane would be cut to the lane's width.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { JournalEvent, SessionRecord } from "@daydream-code/shared";
import { useHarness } from "../harness.js";
import { isLive } from "../sessions.js";
import { toolNames } from "../tool-view.js";
import { useWorkspace } from "../workspace.js";
import { StatusGlyph } from "../ui.js";
import { Event, ToolGroup, TranscriptSkeleton, cycleTitles, groupEvents } from "./SessionPanel.js";

export function ThreadPeek(props: { sessionId: string; fallbackTitle: string }): ReactNode {
  const { sessionId } = props;
  const { api, subscribe } = useHarness();
  const { status } = useWorkspace();
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [events, setEvents] = useState<JournalEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .session(sessionId)
      .then((detail) => {
        if (cancelled) return;
        setSession(detail.session);
        setEvents(detail.journal);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setEvents([]);
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [api, sessionId]);

  useEffect(
    () =>
      subscribe((frame) => {
        if (frame.kind === "journal" && (frame.event.sessionId as string) === sessionId) {
          setEvents((prev) =>
            prev === null || prev.some((e) => e.id === frame.event.id) ? prev : [...prev, frame.event],
          );
        }
        if (frame.kind === "session" && (frame.session.id as string) === sessionId) setSession(frame.session);
      }),
    [subscribe, sessionId],
  );

  const live = session !== null && isLive(session);
  const grouped = useMemo(() => groupEvents(events ?? [], { live }), [events, live]);
  const titles = useMemo(() => cycleTitles(events ?? []), [events]);
  const names = useMemo(() => toolNames(events ?? []), [events]);
  const changed = useMemo(() => new Map(status.files.map((f) => [f.path, f])), [status.files]);

  // The end of a thread is what a peek is for: where it got to. Pinned to the
  // bottom as events stream in, unless the wheel has moved it off.
  const feedRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const feed = feedRef.current;
    if (feed !== null && pinned.current) feed.scrollTop = feed.scrollHeight;
  }, [events]);

  const title = session?.title ?? session?.name ?? props.fallbackTitle;

  return createPortal(
    <div className="thread-peek-scrim">
      <section className="thread-peek glass-strong" role="dialog" aria-label={`Preview of ${title}`}>
        <header className="thread-peek-head">
          <StatusGlyph status={session?.status ?? "pending"} />
          <span className="thread-peek-title">{title}</span>
          <span className="thread-peek-hint">release to close</span>
        </header>
        <div
          className="transcript thread-peek-feed"
          ref={feedRef}
          onScroll={() => {
            const feed = feedRef.current;
            if (feed !== null) pinned.current = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
          }}
        >
          <div className="column">
            {events === null && <TranscriptSkeleton />}
            {error !== null && <p className="thread-peek-empty">{error}</p>}
            {events !== null && events.length === 0 && error === null && (
              <p className="thread-peek-empty">Nothing journaled yet.</p>
            )}
            {grouped.map((item) =>
              item.kind === "event" ? (
                <Event
                  key={item.event.id}
                  event={item.event}
                  names={names}
                  changed={changed}
                  running={item.running === true}
                  {...(titles.has(item.event.id) ? { cycleTitle: titles.get(item.event.id)! } : {})}
                />
              ) : (
                <ToolGroup key={item.key} events={item.events} names={names} changed={changed} />
              ),
            )}
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}
