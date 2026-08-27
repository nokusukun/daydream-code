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
import type { NextMessage } from "@daydream-code/session";
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
import { Entry as Row } from "./Entry.js";
import { Attachments, imageParts } from "./Attachments.js";
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
import { openTextContextMenu } from "../text-context.js";

export function SessionPanel(props: { id: string }): ReactNode {
  const { id } = props;
  const { api, subscribe, resyncTick, view, connection } = useHarness();
  const { status } = useWorkspace();
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [events, setEvents] = useState<JournalEvent[] | null>(null);
  const [nextMessages, setNextMessages] = useState<NextMessage[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEvents(null);
    setSession(null);
    setNextMessages([]);
    api
      .session(id)
      .then((detail) => {
        if (cancelled) return;
        setSession(detail.session);
        setEvents(detail.journal);
        // An older core omits this field. Version skew must degrade to an
        // empty queue, not pass `undefined` into the queue renderer.
        setNextMessages(detail.nextMessages ?? []);
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
          setNextMessages((current) => nextMessagesAfter(current, frame.event));
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

  const running = session?.status === "running";
  // The fold takes `running` because it treats the call in flight differently,
  // and only a live session has one.
  const grouped = useMemo(
    () => groupEvents(events ?? [], { live: running }),
    [events, running],
  );
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
    <main className={`panel${nextMessages.length === 0 ? "" : " panel-has-next-message"}`}>
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
        <div
          className="transcript"
          ref={feedRef}
          onScroll={onScroll}
          onContextMenu={openTextContextMenu}
        >
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
                  running={item.running === true}
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
                <i />
                <i />
                <i />
                {/* The label is for screen readers only: the dots carry the
                    meaning visually, and the word next to them read as noise. */}
                <span className="live-hint-label">working</span>
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
        <QuestionPrompt
          sessionId={id}
          pending={pending}
          nextMessages={nextMessages}
          onNextMessages={setNextMessages}
          onError={setError}
        />
      ) : (
        <MessageComposer
          session={session}
          id={id}
          nextMessages={nextMessages}
          onNextMessages={setNextMessages}
          onError={setError}
        />
      )}
    </main>
  );
}

/** Apply one live journal event to the server-owned next-message snapshot. */
export function nextMessagesAfter(
  current: NextMessage[],
  event: JournalEvent,
): NextMessage[] {
  const payload = payloadOf(event);
  if (
    event.type === "user_message_deferred" ||
    event.type === "user_message_updated"
  ) {
    if (
      typeof payload.deliveryId !== "string" ||
      typeof payload.message !== "string" ||
      typeof payload.createdAt !== "string" ||
      !Array.isArray(payload.images)
    ) {
      return current;
    }
    const next = {
      ...payload,
      editing: payload.editing === true,
    } as unknown as NextMessage;
    const at = current.findIndex((item) => item.deliveryId === next.deliveryId);
    if (at < 0) return [...current, next];
    return current.map((item, index) => (index === at ? next : item));
  }
  if (
    (event.type === "user_message_released" ||
      event.type === "user_message_cancelled") &&
    typeof payload.deliveryId === "string"
  ) {
    return current.filter((item) => item.deliveryId !== payload.deliveryId);
  }
  return current;
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

/**
 * Events that draw nothing.
 *
 * Claude journals a `thinking` event for every thinking block whether or not
 * any text came with it — in this project's store that is 766 of 766 — and an
 * invisible row still ended the run it sat in. That is how one stretch of tool
 * traffic came out as six separate "2 tool calls" rows with loose pairs
 * between them: the grouper was reading the journal, and the reader was
 * looking at the screen.
 *
 * So grouping decides on what will be drawn. The predicate lives here rather
 * than inside `Event` because both need it and the two must not drift: a rule
 * that hides a row in one place and splits a group in the other is the bug
 * this fixes.
 */
export function drawsNothing(event: JournalEvent): boolean {
  const payload = payloadOf(event);
  const blank = short(payload.text ?? "").trim().length === 0;
  switch (event.type) {
    case "turn":
    case "thinking":
      return blank;
    // A captionless screenshot is a message. Only one carrying neither text
    // nor image is nothing.
    case "user_message_queued":
    case "user_injected":
      return blank && imageParts(payload.images).length === 0;
    case "user_message_deferred":
    case "user_message_updated":
    case "user_message_released":
    case "user_message_cancelled":
      return true;
    default:
      return false;
  }
}

type Item =
  | { kind: "event"; event: JournalEvent; running?: true }
  | { kind: "tools"; key: number; events: JournalEvent[] };

/** The id a call and its result agree on, or null when the driver ships none. */
function callIdOf(event: JournalEvent): string | null {
  const payload = payloadOf(event);
  const id = payload.toolCallId ?? payload.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Some providers encode completion on the call itself instead of journaling a
 * separate result. Codex file changes are the concrete case: its SDK emits the
 * item only after the patch succeeds or fails, and the driver preserves that
 * terminal status on a lone `tool_call` row.
 */
function isTerminalCall(event: JournalEvent): boolean {
  if (event.type !== "tool_call") return false;
  const status = payloadOf(event).status;
  return status === "completed" || status === "failed";
}

/**
 * The calls a run has opened and not closed yet, in journal order.
 *
 * Pairing is by id where there is one — Claude's result blocks carry the call
 * id and nothing else — and FIFO otherwise, because some drivers journal a
 * bare result with no id at all. Both paths are needed: matching only by id
 * would leave every call of an id-less driver looking unfinished forever.
 */
function openCalls(run: readonly JournalEvent[]): JournalEvent[] {
  const open: JournalEvent[] = [];
  for (const event of run) {
    if (event.type === "tool_call") {
      if (!isTerminalCall(event)) open.push(event);
      continue;
    }
    const id = callIdOf(event);
    const at = id === null ? 0 : open.findIndex((call) => callIdOf(call) === id);
    if (at >= 0) open.splice(at, 1);
  }
  return open;
}

/**
 * Consecutive tool traffic collapses into one row; anything else breaks the
 * run. A run of a single call stays inline, because wrapping one quiet row in
 * a second layer buys nothing.
 *
 * The count decides here rather than in the renderer so that "what groups" is
 * one pure function with tests, instead of a rule the feed re-derives while
 * drawing.
 *
 * `live` exempts the calls the session is *inside right now* from the fold.
 * Watching a running session is the one case where the collapsed row answers
 * the wrong question: it says what already happened, and folding away the call
 * in flight hides the only line that says what is happening. It takes a flag
 * rather than inferring liveness from a dangling call, because a session that
 * died mid-call leaves one behind and that call is not running.
 */
export function groupEvents(
  events: readonly JournalEvent[],
  options: { live?: boolean } = {},
): Item[] {
  const out: Item[] = [];
  let run: JournalEvent[] = [];
  const delivered = new Set(
    events
      .filter((event) => event.type === "user_injected")
      .map((event) => payloadOf(event).deliveryId)
      .filter((id): id is string => typeof id === "string"),
  );

  // `tail` is the run at the end of the feed — the only one that can still
  // have a call in flight, since anything drawn after it proves the call
  // returned.
  const flush = (tail: boolean): void => {
    if (run.length === 0) return;
    const inFlight = tail && options.live === true ? openCalls(run) : [];
    const settled = inFlight.length === 0 ? run : run.filter((e) => !inFlight.includes(e));
    const calls = settled.filter((event) => event.type === "tool_call").length;
    if (calls >= 2) out.push({ kind: "tools", key: settled[0]!.id, events: settled });
    else for (const event of settled) out.push({ kind: "event", event });
    for (const event of inFlight) out.push({ kind: "event", event, running: true });
    run = [];
  };

  for (const event of events) {
    if (
      event.type === "user_message_queued" &&
      delivered.has(String(payloadOf(event).deliveryId ?? ""))
    ) {
      continue;
    }
    if (drawsNothing(event)) continue;
    if (TOOL_TYPES.has(event.type)) {
      run.push(event);
      continue;
    }
    flush(false);
    out.push({ kind: "event", event });
  }
  flush(true);
  return out;
}

/** "Bash ×11, Read ×2" — what a collapsed run did, without opening it. */
export function groupLabel(events: readonly JournalEvent[]): string {
  return summarize(events).label;
}

function toolName(event: JournalEvent): string {
  const p = payloadOf(event);
  return String(p.name ?? p.toolName ?? p.tool ?? "tool");
}

/** "Bash ×11, Read ×2" — what the group actually did, without opening it. */
function summarize(
  events: readonly JournalEvent[],
): { label: string; calls: number; errors: number } {
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

  return (
    <Row kind="tools" className={`tool-group${open ? " is-open" : ""}`}>
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
    </Row>
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
    case "images_attached": {
      // The images themselves are drawn on the message above this row; all
      // this line owes is the fact that they were stored, not their ids.
      const count = Array.isArray(p.images) ? p.images.length : 0;
      return `${count} image${count === 1 ? "" : "s"} attached`;
    }
    default:
      return null;
  }
}

function payloadOf(event: JournalEvent): Record<string, unknown> {
  return typeof event.payload === "object" && event.payload !== null
    ? (event.payload as Record<string, unknown>)
    : {};
}

export function Event(props: {
  event: JournalEvent;
  names: ReadonlyMap<string, string>;
  changed: ReadonlyMap<string, ChangedFile>;
  /** This call is the one the run is inside right now. */
  running?: boolean;
}): ReactNode {
  const { event } = props;
  const payload = payloadOf(event);
  const images = imageParts(payload.images);

  // `groupEvents` already drops these so they cannot split a run of tool
  // calls; this is the same rule at the one place that would otherwise draw a
  // husk — an entry row collapsed to a hairline.
  if (drawsNothing(event)) return null;

  switch (event.type) {
    case "session_started": {
      const text = short(payload.task ?? "");
      return (
        <>
          {(text.trim().length > 0 || images.length > 0) && (
            <Row kind="you" label="you" time={fmtTime(event.ts)} copyText={text}>
              {text.trim().length > 0 && (
                <div className="entry-prose">
                  <Markdown text={text} />
                </div>
              )}
              <Attachments images={images} />
            </Row>
          )}
          <Tool
            arrow="·"
            meta
            card={{
              name: metaLabel(event) ?? "session started",
              preview: fmtTime(event.ts),
              caption: null,
              body: { kind: "code", lang: "json", text: short(event.payload) },
              shell: false,
            }}
          />
        </>
      );
    }
    case "turn": {
      const text = short(payload.text ?? "");
      return (
        <Row kind="reply" label="reply" time={fmtTime(event.ts)} copyText={text}>
          <div className="entry-prose">
            <Markdown text={text} />
          </div>
        </Row>
      );
    }
    case "user_message_queued": {
      const text = short(payload.text ?? "");
      return (
        <Row
          kind="you"
          label="you"
          time={fmtTime(event.ts)}
          meta={<span className="entry-pending-state">pending</span>}
          className="entry-pending"
          copyText={text}
        >
          {text.trim().length > 0 && (
            <div className="entry-prose">
              <Markdown text={text} />
            </div>
          )}
          <Attachments images={images} />
        </Row>
      );
    }
    case "user_injected": {
      const text = short(payload.text ?? "");
      return (
        <Row kind="you" label="you" time={fmtTime(event.ts)} copyText={text}>
          {text.trim().length > 0 && (
            <div className="entry-prose">
              <Markdown text={text} />
            </div>
          )}
          <Attachments images={images} />
        </Row>
      );
    }
    case "master_injected": {
      const text = short(payload.text ?? payload);
      return (
        <Row
          kind="master"
          label="master thread"
          time={fmtTime(event.ts)}
          copyText={text}
        >
          <div className="entry-prose">
            <Markdown text={text} />
          </div>
        </Row>
      );
    }
    case "thinking": {
      const text = short(payload.text ?? "");
      // No timestamp: thinking is the one row that should recede, and the turn
      // it belongs to is timestamped a few rows down.
      return (
        <Row kind="thinking" label="thinking" copyText={text}>
          <div className="entry-prose entry-prose-quiet">
            <Markdown text={text} />
          </div>
        </Row>
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
      return (
        <Tool
          card={describeTool(event.type, event.payload, props.names)}
          arrow="→"
          running={props.running === true}
        />
      );
    }
    case "tool_result":
      return <Tool card={describeTool(event.type, event.payload, props.names)} arrow="←" />;
    case "tool_error":
      return (
        <Tool card={describeTool(event.type, event.payload, props.names)} arrow="✗" error />
      );
    case "turn_end":
      return <Row kind="turn_end" label="turn end" time={fmtTime(event.ts)} />;
    case "question_asked": {
      const questions = (payloadOf(event).questions ?? []) as {
        header: string;
        question: string;
        options: { label: string; description: string }[];
      }[];
      const text = questions
        .map((question) =>
          [
            question.question,
            ...question.options.map(
              (option) => `- ${option.label}: ${option.description}`,
            ),
          ].join("\n"),
        )
        .join("\n\n");
      return (
        <Row
          kind="question"
          label="question"
          time={fmtTime(event.ts)}
          copyText={text}
        >
          <div className="event-line event-question">
            {questions.map((q) => (
              <p key={q.question}>
                <span className="question-chip">{q.header}</span> {q.question}
              </p>
            ))}
          </div>
        </Row>
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
      return (
        <Row kind="answer" label="answer" time={fmtTime(event.ts)} copyText={said}>
          <p className="event-line event-answer">{said}</p>
        </Row>
      );
    }
    case "driver_error": {
      const text = short(payload.error ?? payload, 800);
      return (
        <Row kind="error" label="driver error" time={fmtTime(event.ts)} copyText={text}>
          <p className="event-line event-error">{text}</p>
        </Row>
      );
    }
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
  running?: boolean;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const { card } = props;
  const label = useMemo(() => `${props.arrow} ${card.name}`, [props.arrow, card.name]);
  const failed = props.error === true || card.caption === "failed" || /^exit /.test(card.caption ?? "");
  const copyText = card.body.kind === "empty" ? card.preview : card.body.text;

  return (
    <Row
      kind={failed ? "error" : props.meta === true ? "meta" : "tool"}
      copyText={copyText}
      className={
        `tool${open ? " is-open" : ""}` +
        (failed ? " tool-error" : "") +
        (props.meta === true ? " tool-meta" : "") +
        (props.running === true ? " tool-running" : "") +
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
    </Row>
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
    <Row kind="patch" label="wrote" copyText={relative}>
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
    </Row>
  );
}
