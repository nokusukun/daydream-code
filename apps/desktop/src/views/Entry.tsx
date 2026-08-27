/**
 * The timeline row both feeds are built from: a gutter mark and a body.
 *
 * The master thread and a session transcript are the same object at two
 * scales — one story per project, one story per run — so they are drawn the
 * same way, and the shared shell is what keeps a new kind of row from drifting
 * back into a card. A semantic icon and the kind label carry the grouping that
 * a box would otherwise have to. The icons deliberately stand alone:
 * connector lines made dense tool traffic look like a second nested thread.
 */
import type { ReactNode } from "react";

/** One restrained outline family for every event kind the two feeds render. */
function EntryMark(props: { kind: string }): ReactNode {
  let body: ReactNode;
  switch (props.kind) {
    case "dispatch":
      body = <path d="m5 3 7 5-7 5Z" fill="currentColor" stroke="none" />;
      break;
    case "summary":
      body = <path d="M3.5 3.5h9m-9 3h7m-7 3h9m-9 3h5" />;
      break;
    case "turn_end":
    case "answer":
      body = (
        <>
          <circle cx="8" cy="8" r="5.5" />
          <path d="m5.2 8 1.8 1.8 3.8-4" />
        </>
      );
      break;
    case "note":
      body = <path d="M4 2.5h6l2 2v9H4Zm6 0v2h2M6 7h4m-4 3h3" />;
      break;
    case "compaction":
      body = (
        <path d="m2.5 2.5 3.7 3.7M6.2 3v3.2H3m10.5-3.7L9.8 6.2M13 6.2H9.8V3m-7.3 10.5 3.7-3.7M3 9.8h3.2V13m7.3.5L9.8 9.8M9.8 13V9.8H13" />
      );
      break;
    case "message":
    case "reply":
      body = <path d="M3 3.5h10v7H7l-3 2v-2H3Z" />;
      break;
    case "you":
      body = <path d="m3.5 12.5 9-9m-6 0h6v6" />;
      break;
    case "master":
      body = (
        <path d="M2.5 3.5c2-.4 3.8.1 5.5 1.4v8c-1.7-1.3-3.5-1.8-5.5-1.4Zm11 0c-2-.4-3.8.1-5.5 1.4v8c1.7-1.3 3.5-1.8 5.5-1.4Z" />
      );
      break;
    case "patch":
      body = <path d="M4 2.5h6l2 2v9H4Zm6 0v2h2M8 7v4M6 9h4" />;
      break;
    case "question":
      body = (
        <>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M6.5 6.2A1.6 1.6 0 0 1 8.1 5c1 0 1.8.6 1.8 1.5 0 1.5-1.9 1.5-1.9 3M8 11.8h.01" />
        </>
      );
      break;
    case "error":
      body = <path d="M8 2.2 14 13H2Zm0 3.3v3.7m0 1.8h.01" />;
      break;
    case "tool":
    case "tools":
      body = <path d="m3 5 3 3-3 3m5 0h5" />;
      break;
    case "thinking":
      body = (
        <>
          <circle cx="3.5" cy="8" r="1" fill="currentColor" stroke="none" />
          <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
          <circle cx="12.5" cy="8" r="1" fill="currentColor" stroke="none" />
        </>
      );
      break;
    case "meta":
      body = (
        <>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M8 7v4m0-6h.01" />
        </>
      );
      break;
    default:
      body = <circle cx="8" cy="8" r="2.5" fill="currentColor" stroke="none" />;
  }

  return (
    <svg
      className={`entry-mark entry-mark-${props.kind}`}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {body}
    </svg>
  );
}

export function Entry(props: {
  /**
   * Both the mark's colour class and, unless `label` overrides it, what the
   * row calls itself.
   */
  kind: string;
  label?: string;
  time?: string;
  /** Extra meta between the label and the time: a session link, a count. */
  meta?: ReactNode;
  /**
   * Plain source copied when this row is right-clicked without a selection.
   * Keep it separate from rendered text: labels, timestamps and collapsed
   * previews are presentation, not part of the thread message.
   */
  copyText?: string;
  className?: string;
  children?: ReactNode;
}): ReactNode {
  const label = props.label ?? null;
  const showMeta = label !== null || props.meta !== undefined || props.time !== undefined;

  return (
    <article
      className={`entry${props.className !== undefined ? ` ${props.className}` : ""}`}
      {...(props.copyText !== undefined && props.copyText.trim().length > 0
        ? { "data-copy-text": props.copyText }
        : {})}
    >
      <div className="entry-gutter" aria-hidden="true">
        <EntryMark kind={props.kind} />
      </div>
      <div className="entry-body">
        {showMeta && (
          <div className="entry-meta">
            {label !== null && <span className="entry-kind">{label}</span>}
            {props.meta}
            {props.time !== undefined && <span className="entry-time">{props.time}</span>}
          </div>
        )}
        {props.children}
      </div>
    </article>
  );
}
