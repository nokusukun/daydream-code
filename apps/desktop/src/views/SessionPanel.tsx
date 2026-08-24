/**
 * The main panel with a run selected: its transcript, its files, its bill.
 *
 * The transcript is rebuilt from the journal and then kept live off the
 * websocket, so a panel opened mid-run shows everything that happened before
 * you looked and everything that happens while you watch, from one source.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { JournalEvent, SessionRecord } from "@daydream-code/shared";
import { useHarness } from "../harness.js";
import { pendingQuestionFrom } from "../pending-question.js";
import { QuestionPrompt } from "./QuestionPrompt.js";
import { PanelHead } from "./PanelHead.js";
import { ChangesView } from "./ChangesView.js";
import { UsageView } from "./UsageView.js";
import { MessageComposer } from "./Composer.js";
import { StatusGlyph, fmtDateTime, fmtTime, peek, short } from "../ui.js";
import { ProviderIcon } from "../provider-icon.js";
import { Code, Fence, Markdown, Output } from "../prose.js";
import {
  describeTool,
  relativeTo,
  toolNames,
  writtenPath,
  writtenPaths,
  type ToolBody,
  type ToolCard,
} from "../tool-view.js";
import { useWorkspace } from "../workspace.js";
import type { ChangedFile } from "../api.js";

export function SessionPanel(props: { id: string }): ReactNode {
  const { id } = props;
  const { api, subscribe, resyncTick, view, connection } = useHarness();
  const { status } = useWorkspace();
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [events, setEvents] = useState<JournalEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEvents(null);
    setSession(null);
    api
      .session(id)
      .then((detail) => {
        if (cancelled) return;
        setSession(detail.session);
        setEvents(detail.journal);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setEvents([]);
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [api, id, resyncTick]);

  useEffect(
    () =>
      subscribe((frame) => {
        if (frame.kind === "journal" && (frame.event.sessionId as string) === id) {
          setEvents((prev) =>
            prev === null || prev.some((e) => e.id === frame.event.id)
              ? prev
              : [...prev, frame.event],
          );
        }
        if (frame.kind === "session" && (frame.session.id as string) === id) {
          setSession(frame.session);
        }
      }),
    [subscribe, id],
  );

  // Auto-scroll that yields the moment the user scrolls up to read.
  const feedRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const onScroll = useCallback(() => {
    const feed = feedRef.current;
    if (feed === null) return;
    pinned.current = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
  }, []);
  useLayoutEffect(() => {
    const feed = feedRef.current;
    if (feed !== null && pinned.current) feed.scrollTop = feed.scrollHeight;
  }, [events, view]);

  const grouped = useMemo(() => groupEvents(events ?? []), [events]);
  // Claude's tool results carry the call id and no name, so the name has to
  // come from the call that opened it.
  const names = useMemo(() => toolNames(events ?? []), [events]);
  // Which files this run wrote, as git spells them. The Changes tab intersects
  // this with the working tree, so a file the run edited and then reverted
  // correctly drops off.
  const touched = useMemo(
    () => writtenPaths(events ?? [], connection.rootPath),
    [events, connection.rootPath],
  );
  // Last `context_assembled` wins: a resumed session can change model.
  const reportedModel = useMemo(() => {
    for (let i = (events?.length ?? 0) - 1; i >= 0; i -= 1) {
      const event = events![i]!;
      if (event.type !== "context_assembled") continue;
      const model = payloadOf(event).model;
      if (typeof model === "string" && model.length > 0) return model;
    }
    return null;
  }, [events]);
  const running = session?.status === "running";
  // Derived from the transcript, not from a flag: the journal is already
  // streamed here, so a client that reconnects mid-block rebuilds the prompt
  // from what it just loaded. A `cancelled` settle retires it, which is how a
  // question whose process died stops being offered.
  //
  // Safe against the loader's tail limit: an open question blocks its turn, so
  // the session cannot emit hundreds of later events while one is outstanding.
  // A `question_asked` that has scrolled out of the window belongs to a turn
  // that kept running — i.e. one already settled.
  const pending = useMemo(() => pendingQuestionFrom(events ?? []), [events]);
  const changed = useMemo(
    () => new Map(status.files.map((f) => [f.path, f])),
    [status.files],
  );

  return (
    <main className="panel">
      <div className="panel-top">
        <Head
          session={session}
          id={id}
          reportedModel={reportedModel}
          onError={setError}
        />
        {error !== null && (
          <div className="error-bar">
            {error}
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => setError(null)}
            >
              dismiss
            </button>
          </div>
        )}
      </div>

      {view === "thread" && (
        <div className="transcript" ref={feedRef} onScroll={onScroll}>
          <div className="column">
            {events === null && <TranscriptSkeleton />}
            {events !== null && events.length === 0 && (
              <div className="empty">
                <p className="empty-title">Nothing journaled yet</p>
                <p className="empty-body">
                  Every turn, thought and tool call this run makes lands here the
                  moment it is committed.
                </p>
              </div>
            )}
            {grouped.map((item) =>
              item.kind === "event" ? (
                <Event
                  key={item.event.id}
                  event={item.event}
                  names={names}
                  changed={changed}
                />
              ) : (
                <ToolGroup
                  key={item.key}
                  events={item.events}
                  names={names}
                  changed={changed}
                />
              ),
            )}
            {running && (
              <p className="live-hint" aria-live="polite">
                <i /> <i /> <i /> working
              </p>
            )}
          </div>
        </div>
      )}

      {view === "changes" && (
        <div className="panel-scroll">
          <div className="column">
            <ChangesView
              paths={touched}
              note={
                <>
                  Files this run wrote that still differ from <code>HEAD</code>.
                  Anything it changed through the shell shows up on the master
                  thread's Changes tab, which reads the whole tree.
                </>
              }
            />
          </div>
        </div>
      )}

      {view === "usage" && (
        <div className="panel-scroll">
          <div className="column">
            <UsageView
              sessions={session === null ? [] : [session]}
              events={events ?? []}
            />
          </div>
        </div>
      )}

      {view === "thread" && pending !== null ? (
        <QuestionPrompt sessionId={id} pending={pending} onError={setError} />
      ) : (
        <MessageComposer session={session} id={id} onError={setError} />
      )}
    </main>
  );
}

/** 56.6k — the bar has room for a number, not for six digits. */
function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}m`;
}

/**
 * One strip, not two bands. Identity on the left, the numbers that change
 * while you watch in the middle, the view tabs at the end. Everything that is
 * reference rather than glanceable (exact timestamps, exact token counts)
 * lives in the title attribute.
 */
function Head(props: {
  session: SessionRecord | null;
  id: string;
  /** Model the driver actually ran, when the session pinned none. */
  reportedModel: string | null;
  onError(message: string): void;
}): ReactNode {
  const { api, modelLabel } = useHarness();
  const { session, id } = props;

  const stop = useCallback(() => {
    api
      .stop(id)
      .catch((e: unknown) => props.onError(e instanceof Error ? e.message : String(e)));
  }, [api, id, props]);

  if (session === null) return <PanelHead title={id} />;

  const { usage } = session;
  // A session that pinned no model still ran on one; the driver reports which
  // in `context_assembled`, so the strip can always name it.
  const effective = session.modelId ?? props.reportedModel;
  const model = modelLabel(session.driver, effective);
  const usedTokens = usage.tokensIn + usage.tokensOut;
  const when =
    session.endedAt !== null
      ? `${fmtDateTime(session.startedAt)} → ${fmtDateTime(session.endedAt)}`
      : `started ${fmtDateTime(session.startedAt)}`;

  return (
    <PanelHead
      title={
        <>
          <StatusGlyph status={session.status} />
          {session.title ?? session.name}
        </>
      }
      sub={
        <span className="bar-facts" title={`${session.name} · ${when}`}>
          <span className="bar-fact bar-model" title={effective ?? session.driver}>
            <ProviderIcon driver={session.driver} />
            {model.label}
            {model.variant !== undefined && (
              <span className="bar-variant">{model.variant}</span>
            )}
          </span>
          {usedTokens > 0 && (
            <span
              className="bar-fact"
              title={`${usage.tokensIn.toLocaleString()} in · ${usage.tokensOut.toLocaleString()} out`}
            >
              {compact(usage.tokensIn)} <i>in</i> {compact(usage.tokensOut)} <i>out</i>
            </span>
          )}
          {usage.costUsd > 0 && (
            <span className="bar-fact" title={`$${usage.costUsd.toFixed(4)}`}>
              ${usage.costUsd.toFixed(2)}
            </span>
          )}
        </span>
      }
    >
      {/* `waiting` is stoppable too — a session blocked on a question you do
          not want to answer is exactly one you might want to kill. */}
      {(session.status === "running" || session.status === "waiting") && (
        <button type="button" className="btn btn-danger" onClick={stop}>
          stop
        </button>
      )}
    </PanelHead>
  );
}

function TranscriptSkeleton(): ReactNode {
  return (
    <div aria-busy="true" style={{ display: "grid", gap: 12 }}>
      <div className="skeleton" style={{ height: 58, width: "62%" }} />
      <div className="skeleton" style={{ height: 26, width: "100%", opacity: 0.6 }} />
      <div
        className="skeleton"
        style={{ height: 78, width: "74%", alignSelf: "end", opacity: 0.4 }}
      />
    </div>
  );
}

/**
 * Tool traffic is the bulk of any transcript (a single turn here ran 66 Bash
 * calls). Consecutive tool events collapse into one summary row so the prose
 * stays readable; the row opens to the individual calls, and each call opens
 * to its payload.
 */
const TOOL_TYPES = new Set(["tool_call", "tool_result", "tool_error"]);

type Item =
  | { kind: "event"; event: JournalEvent }
  | { kind: "tools"; key: number; events: JournalEvent[] };

function groupEvents(events: JournalEvent[]): Item[] {
  const out: Item[] = [];
  for (const event of events) {
    if (!TOOL_TYPES.has(event.type)) {
      out.push({ kind: "event", event });
      continue;
    }
    const last = out[out.length - 1];
    if (last !== undefined && last.kind === "tools") last.events.push(event);
    else out.push({ kind: "tools", key: event.id, events: [event] });
  }
  return out;
}

function toolName(event: JournalEvent): string {
  const p = payloadOf(event);
  return String(p.name ?? p.toolName ?? "tool");
}

/** "Bash ×11, Read ×2" — what the group actually did, without opening it. */
function summarize(events: JournalEvent[]): { label: string; calls: number; errors: number } {
  const counts = new Map<string, number>();
  let calls = 0;
  let errors = 0;
  for (const event of events) {
    if (event.type === "tool_result") continue;
    if (event.type === "tool_error") errors += 1;
    else calls += 1;
    const name = toolName(event);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const label = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
    .join(", ");
  return { label, calls, errors };
}

function ToolGroup(props: {
  events: JournalEvent[];
  names: ReadonlyMap<string, string>;
  changed: ReadonlyMap<string, ChangedFile>;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const { label, calls, errors } = useMemo(() => summarize(props.events), [props.events]);

  // A lone call is already quiet; don't wrap it in a second layer.
  if (calls + errors <= 1) {
    return (
      <>
        {props.events.map((event) => (
          <Event
            key={event.id}
            event={event}
            names={props.names}
            changed={props.changed}
          />
        ))}
      </>
    );
  }

  return (
    <div className={`tool-group${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="tool-group-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="tool-caret" aria-hidden="true">
          ▶
        </span>
        <span className="tool-group-count">
          {calls} tool call{calls === 1 ? "" : "s"}
        </span>
        <span className="tool-group-names">{label}</span>
        {errors > 0 && (
          <span className="tool-group-errors">
            {errors} failed
          </span>
        )}
      </button>
      {open && (
        <div className="tool-group-body">
          {props.events.map((event) => (
            <Event
              key={event.id}
              event={event}
              names={props.names}
              changed={props.changed}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Lifecycle events carry large payloads (the full tool list, the whole
 * summary) that nobody reads inline. They collapse to a one-line label and
 * keep the payload one click away.
 */
function metaLabel(event: JournalEvent): string | null {
  const p = payloadOf(event);
  switch (event.type) {
    case "session_started":
      return [
        "session started",
        typeof p.driver === "string" ? p.driver : null,
        p.resumed === true ? "resumed" : null,
      ]
        .filter(Boolean)
        .join(" · ");
    case "context_assembled": {
      const tools = Array.isArray(p.tools) ? `${p.tools.length} tools` : null;
      return ["context assembled", typeof p.model === "string" ? p.model : null, tools]
        .filter(Boolean)
        .join(" · ");
    }
    case "session_ended":
      return `session ended${typeof p.status === "string" ? ` · ${p.status}` : ""}`;
    default:
      return null;
  }
}

function payloadOf(event: JournalEvent): Record<string, unknown> {
  return typeof event.payload === "object" && event.payload !== null
    ? (event.payload as Record<string, unknown>)
    : {};
}

function Event(props: {
  event: JournalEvent;
  names: ReadonlyMap<string, string>;
  changed: ReadonlyMap<string, ChangedFile>;
}): ReactNode {
  const { event } = props;
  const payload = payloadOf(event);

  switch (event.type) {
    case "turn": {
      // Models that omit thinking text still journal the event; an empty
      // bubble is a hairline artifact, so drop it rather than render a husk.
      const text = short(payload.text ?? "");
      if (text.trim().length === 0) return null;
      return (
        <div className="bubble bubble-assistant">
          <Markdown text={text} />
          <span className="bubble-time">{fmtTime(event.ts)}</span>
        </div>
      );
    }
    case "user_injected": {
      const text = short(payload.text ?? "");
      if (text.trim().length === 0) return null;
      return (
        <div className="bubble bubble-user">
          <Markdown text={text} />
          <span className="bubble-time">{fmtTime(event.ts)}</span>
        </div>
      );
    }
    case "master_injected":
      return (
        <div className="bubble bubble-master">
          <Markdown text={short(payload.text ?? payload)} />
          <span className="bubble-time">from the master thread · {fmtTime(event.ts)}</span>
        </div>
      );
    case "thinking": {
      const text = short(payload.text ?? "");
      if (text.trim().length === 0) return null;
      return (
        <div className="thinking">
          <Markdown text={text} />
        </div>
      );
    }
    // Every driver shapes tool payloads differently; `describeTool` resolves
    // that variance so this file only decides how a card looks.
    // A call that wrote a file is a patch, not a tool row. The arguments are
    // the least interesting thing about it; which file moved, by how much, and
    // a way to go read it are the whole content.
    case "tool_call": {
      const wrote = writtenPath(event);
      if (wrote !== null) return <Patch path={wrote} changed={props.changed} />;
      return <Tool card={describeTool(event.type, event.payload, props.names)} arrow="→" />;
    }
    case "tool_result":
      return <Tool card={describeTool(event.type, event.payload, props.names)} arrow="←" />;
    case "tool_error":
      return (
        <Tool card={describeTool(event.type, event.payload, props.names)} arrow="✗" error />
      );
    case "turn_end":
      return (
        <div className="turn-sep">
          <span>turn end · {fmtTime(event.ts)}</span>
        </div>
      );
    case "question_asked": {
      const questions = (payloadOf(event).questions ?? []) as {
        header: string;
        question: string;
        options: { label: string; description: string }[];
      }[];
      return (
        <div className="event-line event-question">
          {questions.map((q) => (
            <p key={q.question}>
              <span className="question-chip">{q.header}</span> {q.question}
            </p>
          ))}
        </div>
      );
    }
    case "question_settled": {
      const payload = payloadOf(event);
      const kind = String(payload.kind ?? "");
      const said =
        kind === "answered"
          ? Object.values(payload.answers as Record<string, string | string[]>)
              .map((a) => (Array.isArray(a) ? a.join(", ") : a))
              .join(" · ")
          : kind === "replied"
            ? short(payload.text)
            : kind === "declined"
              ? "you decide — proceeding on its own recommendation"
              : `cancelled: ${short(payload.reason)}`;
      return <p className="event-line event-answer">{said}</p>;
    }
    case "driver_error":
      return (
        <p className="event-line event-error">
          driver error: {short(payload.error ?? payload, 800)}
        </p>
      );
    default: {
      const label = metaLabel(event);
      return (
        <Tool
          arrow="·"
          meta
          card={{
            name: label ?? event.type,
            preview: label !== null ? fmtTime(event.ts) : peek(event.payload, 160),
            caption: null,
            body: { kind: "code", lang: "json", text: short(event.payload) },
            shell: false,
          }}
        />
      );
    }
  }
}

/** The opened payload: a command, a file, or whatever the program printed. */
function ToolBodyView(props: { body: ToolBody }): ReactNode {
  const { body } = props;
  switch (body.kind) {
    case "shell":
      return (
        <div className="cmd">
          <span className="cmd-prompt" aria-hidden="true">
            $
          </span>
          <Code code={body.text} lang="shell" wrap />
        </div>
      );
    case "code":
      return <Fence lang={body.lang} text={body.text} />;
    case "output":
      return <Output text={body.text} />;
    case "empty":
      return null;
    default: {
      const exhaustive: never = body;
      return exhaustive;
    }
  }
}

/**
 * Tool calls are the highest-volume event in any session, so they stay on one
 * line with a preview and open only on demand. The preview of a shell call is
 * the command itself, highlighted — finding out what a row ran was the only
 * reason to open most of them.
 */
function Tool(props: {
  card: ToolCard;
  arrow: string;
  error?: boolean;
  meta?: boolean;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const { card } = props;
  const label = useMemo(() => `${props.arrow} ${card.name}`, [props.arrow, card.name]);
  const failed = props.error === true || card.caption === "failed" || /^exit /.test(card.caption ?? "");

  return (
    <div
      className={
        `tool${open ? " is-open" : ""}` +
        (failed ? " tool-error" : "") +
        (props.meta === true ? " tool-meta" : "") +
        (card.shell ? " tool-shell" : "")
      }
    >
      <button
        type="button"
        className="tool-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="tool-caret" aria-hidden="true">
          ▶
        </span>
        <span className="tool-name">{label}</span>
        {!open && (
          <span className="tool-peek">
            {card.shell ? <Code code={card.preview} lang="shell" /> : card.preview}
          </span>
        )}
      </button>
      {open && (
        <div className="tool-body">
          {card.caption !== null && (
            <div className={`tool-caption${failed ? " tool-caption-bad" : ""}`}>
              {card.caption}
            </div>
          )}
          <ToolBodyView body={card.body} />
        </div>
      )}
    </div>
  );
}

/**
 * A write, as the transcript shows it: the file, what git makes of it now, and
 * the way into Code mode.
 *
 * The stat comes from the working tree rather than from the tool's arguments,
 * so a file edited eleven times reports the net change once instead of adding
 * up eleven claims.
 */
function Patch(props: {
  path: string;
  changed: ReadonlyMap<string, ChangedFile>;
}): ReactNode {
  const { connection, openFile } = useHarness();
  const relative = relativeTo(props.path, connection.rootPath);
  const stat = props.changed.get(relative);

  return (
    <button
      type="button"
      className="patch"
      title={`Open ${relative}`}
      onClick={() => openFile(relative)}
    >
      <span className="patch-path">{relative}</span>
      <span className="patch-spacer" />
      {stat !== undefined && !stat.binary && (
        <span className="patch-stat">
          <span className="stat-add">+{stat.added}</span>
          <span className="stat-del">−{stat.removed}</span>
        </span>
      )}
      <span className="patch-open">Open in Code ↗</span>
    </button>
  );
}
