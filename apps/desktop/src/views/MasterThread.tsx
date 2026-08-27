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
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { SessionRecord, ThreadEntry } from "@daydream-code/shared";
import { useHarness } from "../harness.js";
import { clip, digestChunks, entryKind, lede, useMaster } from "../master.js";
import { fmtTime, messageText } from "../ui.js";
import { InlineMarkdown, Markdown } from "../prose.js";
import { Entry as Row } from "./Entry.js";
import { openTextContextMenu } from "../text-context.js";

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
    <div
      className="timeline"
      ref={feedRef}
      onScroll={onScroll}
      onContextMenu={openTextContextMenu}
    >
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
  const kind = entryKind(entry);
  // A digest's first line is its header, which says exactly what the entry is;
  // running `lede` over it would instead surface a sentence from whichever
  // fact happens to be first, which reads as if that fact were the entry.
  const digest = kind === "compaction";
  const flat = text.replace(/\s+/g, " ").trim();
  const first = digest ? clip(text.split("\n", 1)[0] ?? flat) : lede(flat);
  const long = digest ? text.trimEnd().length > first.length : first.length < flat.length;

  return (
    <Row
      kind={kind}
      label={kind}
      time={fmtTime(entry.createdAt)}
      copyText={text}
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
        {open ? (
          digest ? (
            <Digest text={text} />
          ) : (
            <Markdown text={text} />
          )
        ) : (
          <InlineMarkdown text={first} />
        )}
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

/**
 * A compaction digest, revealed a chunk at a time.
 *
 * The whole digest is what the model reads, so the bound belongs here rather
 * than on `summaryChars` in the compactor: shrinking what the model reads to
 * solve a rendering problem trades the wrong thing. Each chunk is its own
 * `Markdown` call over its own slice, so the work stays flat as the digest
 * grows, and a reader who wants all of it still gets all of it.
 */
export function Digest(props: { text: string }): ReactNode {
  const chunks = useMemo(() => digestChunks(props.text), [props.text]);
  const [shown, setShown] = useState(1);
  const visible = chunks.slice(0, shown);

  return (
    <>
      {visible.map((chunk, i) => (
        <Markdown key={i} text={chunk} />
      ))}
      {shown < chunks.length && (
        <button
          type="button"
          className="entry-more"
          onClick={(e) => {
            e.stopPropagation();
            setShown((n) => n + 1);
          }}
        >
          continue reading the digest ({shown} of {chunks.length})
        </button>
      )}
      <p className="entry-aside">
        The entries this replaces are superseded, not deleted — switch the bar
        to full history to read them verbatim.
      </p>
    </>
  );
}
