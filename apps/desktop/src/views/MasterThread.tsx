/**
 * The main panel with the master thread selected: every dispatch, message,
 * summary and turn end, in order.
 *
 * A timeline with a connecting rule rather than a stack of cards — at 200
 * entries the rule reads and 200 boxes do not. Each entry names the session it
 * came from as a link, because the thread's whole job is to be the place where
 * separate runs are one story, and following it back to the run is the move
 * every reader makes.
 */
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { SessionRecord, ThreadEntry } from "@daydream-code/shared";
import { useHarness } from "../harness.js";
import { entryKind, lede, useMaster } from "../master.js";
import { fmtTime, messageText } from "../ui.js";
import { InlineMarkdown, Markdown } from "../prose.js";
import { Entry as Row } from "./Entry.js";

export function MasterThread(props: { showAll: boolean }): ReactNode {
  const { select } = useHarness();
  const { entries, sessions, error } = useMaster(props.showAll);

  // Stick to the bottom unless the user has scrolled up to read history.
  const feedRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const onScroll = useCallback(() => {
    const feed = feedRef.current;
    if (feed === null) return;
    pinned.current = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
  }, []);
  useLayoutEffect(() => {
    const feed = feedRef.current;
    if (feed !== null && pinned.current) feed.scrollTop = feed.scrollHeight;
  }, [entries]);

  return (
    <div className="timeline" ref={feedRef} onScroll={onScroll}>
      <div className="column">
        {error !== null && <div className="error-bar">{error}</div>}

        {entries === null && (
          <div aria-busy="true" className="timeline-skeleton">
            <div className="skeleton" style={{ height: 52 }} />
            <div className="skeleton" style={{ height: 52, opacity: 0.6 }} />
            <div className="skeleton" style={{ height: 52, opacity: 0.3 }} />
          </div>
        )}

        {entries !== null && entries.length === 0 && (
          <div className="empty">
            <p className="empty-title">The thread is empty</p>
            <p className="empty-body">
              Every dispatch, turn end and summary lands here as it happens, and
              every session forks from it. Start a run and this fills in.
            </p>
          </div>
        )}

        {entries?.map((entry) => (
          <Entry
            key={entry.id}
            entry={entry}
            session={
              entry.sessionId !== undefined
                ? sessions.get(entry.sessionId as string)
                : undefined
            }
            onOpen={select}
          />
        ))}
      </div>
    </div>
  );
}

function Entry(props: {
  entry: ThreadEntry;
  session: SessionRecord | undefined;
  onOpen(id: string): void;
}): ReactNode {
  const { entry, session } = props;
  const [open, setOpen] = useState(false);
  const text = messageText(entry.message);
  const flat = text.replace(/\s+/g, " ").trim();
  const first = lede(flat);
  const long = first.length < flat.length;
  const kind = entryKind(entry);

  return (
    <Row
      kind={kind}
      label={kind}
      time={fmtTime(entry.createdAt)}
      {...(open ? { className: "is-open" } : {})}
      meta={
        entry.sessionId !== undefined ? (
          <button
            type="button"
            className="entry-session"
            title={entry.sessionId as string}
            onClick={() => props.onOpen(entry.sessionId as string)}
          >
            {session?.name ?? (entry.sessionId as string)}
          </button>
        ) : undefined
      }
    >
      {/* Thread prose is model output, so it is markdown: sessions write
          `code` spans and **emphasis** into their summaries and broadcasts.
          The lede gets inline syntax only — block syntax in a truncated
          sentence is half a list, and a paragraph wrapper would defeat the
          clamp. */}
      <div className="entry-text">
        {open ? <Markdown text={text} /> : <InlineMarkdown text={first} />}
      </div>
      {long && (
        <button
          type="button"
          className="entry-more"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "show less" : "show more"}
        </button>
      )}
    </Row>
  );
}
