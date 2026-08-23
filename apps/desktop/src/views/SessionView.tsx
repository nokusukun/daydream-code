/**
 * Session view: header (status/driver/usage), live transcript from the
 * journal + WS frames filtered by sessionId, message composer, stop button.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { JournalEvent, SessionRecord } from "@daydream-code/shared";
import { useHarness } from "../harness.js";
import { SplitPane } from "../split.js";
import { StatusPill, fmtDateTime, fmtTime, short } from "../ui.js";

export function SessionView(props: { id: string }): ReactNode {
  const { id } = props;
  const { api, subscribe, resyncTick, navigate } = useHarness();
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [events, setEvents] = useState<JournalEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .session(id)
      .then((detail) => {
        if (cancelled) return;
        setSession(detail.session);
        setEvents(detail.journal);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
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
            prev.some((e) => e.id === frame.event.id) ? prev : [...prev, frame.event],
          );
        }
        if (frame.kind === "session" && (frame.session.id as string) === id) {
          setSession(frame.session);
        }
      }),
    [subscribe, id],
  );

  const feedRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const feed = feedRef.current;
    if (feed !== null) feed.scrollTop = feed.scrollHeight;
  }, [events]);

  // -- composer -------------------------------------------------------------
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const send = useCallback(() => {
    const trimmed = message.trim();
    if (trimmed.length === 0 || busy) return;
    setBusy(true);
    api
      .message(id, trimmed)
      .then(() => setMessage(""))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }, [api, id, message, busy]);

  const stop = useCallback(() => {
    api.stop(id).catch((e: unknown) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  }, [api, id]);

  return (
    <div className="view view-session">
      <div className="view-toolbar">
        <button type="button" onClick={() => navigate({ name: "home" })}>
          ← back
        </button>
        <h2 title={id}>{session?.title ?? id}</h2>
        {session !== null && <StatusPill status={session.status} />}
        {session?.status === "running" && (
          <button type="button" className="danger" onClick={stop}>
            stop
          </button>
        )}
      </div>

      {session !== null && (
        <div className="session-meta">
          <span>driver <b>{session.driver}</b></span>
          {session.modelId !== null && <span>model <b>{session.modelId}</b></span>}
          <span>started <b>{fmtDateTime(session.startedAt)}</b></span>
          {session.endedAt !== null && <span>ended <b>{fmtDateTime(session.endedAt)}</b></span>}
          <span>
            usage <b>{session.usage.tokensIn}</b> in / <b>{session.usage.tokensOut}</b> out
            {session.usage.costUsd > 0 && <> / ${session.usage.costUsd.toFixed(4)}</>}
          </span>
        </div>
      )}
      {session !== null && <div className="session-task">task: {session.task}</div>}

      {error !== null && <div className="error-bar">{error}</div>}

      <SplitPane
        id="session-composer"
        direction="column"
        initial={124}
        min={92}
        max={480}
        first={
          <div className="feed" ref={feedRef}>
            {events.map((event) => (
              <EventRow key={event.id} event={event} />
            ))}
            {events.length === 0 && (
              <div className="empty">No journal events yet.</div>
            )}
          </div>
        }
        second={
          <div className="composer">
            <textarea
              value={message}
              placeholder="Send a message into this session…  (ctrl+enter to send)"
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <div className="composer-row">
              <button
                type="button"
                className="primary"
                disabled={busy || message.trim().length === 0}
                onClick={send}
              >
                {busy ? "sending…" : "send"}
              </button>
            </div>
          </div>
        }
      />
    </div>
  );
}

function payloadOf(event: JournalEvent): Record<string, unknown> {
  return typeof event.payload === "object" && event.payload !== null
    ? (event.payload as Record<string, unknown>)
    : {};
}

function EventRow(props: { event: JournalEvent }): ReactNode {
  const { event } = props;
  const payload = payloadOf(event);

  switch (event.type) {
    case "turn":
      return (
        <div className="bubble bubble-assistant">
          <pre>{short(payload.text ?? payload)}</pre>
          <span className="bubble-time">{fmtTime(event.ts)}</span>
        </div>
      );
    case "user_injected":
      return (
        <div className="bubble bubble-user">
          <pre>{short(payload.text ?? payload)}</pre>
          <span className="bubble-time">{fmtTime(event.ts)}</span>
        </div>
      );
    case "master_injected":
      return (
        <div className="bubble bubble-master">
          <pre>{short(payload.text ?? payload)}</pre>
          <span className="bubble-time">master · {fmtTime(event.ts)}</span>
        </div>
      );
    case "thinking":
      return <pre className="thinking">{short(payload.text ?? payload)}</pre>;
    case "tool_call":
      return (
        <ToolCard
          label={`→ ${String(payload.name ?? payload.toolName ?? "tool")}`}
          body={short(payload.args ?? payload)}
        />
      );
    case "tool_result":
      return (
        <ToolCard
          label={`← ${String(payload.name ?? payload.toolName ?? "result")}`}
          body={short(payload.result ?? payload)}
        />
      );
    case "tool_error":
      return (
        <ToolCard
          label={`✗ ${String(payload.name ?? "tool error")}`}
          body={short(payload.error ?? payload)}
          error
        />
      );
    case "turn_end":
      return (
        <div className="turn-sep">
          <span>turn end · {fmtTime(event.ts)}</span>
        </div>
      );
    case "driver_error":
      return (
        <div className="event-meta event-error">
          driver_error: {short(payload.error ?? payload, 800)}
        </div>
      );
    default:
      return (
        <div className="event-meta">
          <span className="event-type">{event.type}</span> {short(event.payload, 400)}
        </div>
      );
  }
}

function ToolCard(props: { label: string; body: string; error?: boolean }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <div className={`tool-card${props.error === true ? " tool-error" : ""}`}>
      <button type="button" className="tool-head" onClick={() => setOpen((o) => !o)}>
        <span className="tool-caret">{open ? "▾" : "▸"}</span> {props.label}
      </button>
      {open && <pre className="tool-body">{props.body}</pre>}
    </div>
  );
}
