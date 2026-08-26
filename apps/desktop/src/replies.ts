/**
 * The latest meaningful activity in each run, kept live.
 *
 * A session title already says what the user asked for. The rail's second line
 * answers the more useful question: what is the run doing now? Assistant prose,
 * tool calls, questions, sibling messages and failures all share one bounded
 * journal seed and the websocket the rail already listens to.
 *
 * Low-information events are deliberately absent. A successful tool result
 * does not immediately erase the call that produced it, and `turn_end` /
 * `session_ended` do not repeat state already carried by the status glyph.
 */
import { useEffect, useState } from "react";
import type { JournalEvent } from "@daydream-code/shared";
import { useHarness } from "./harness.js";
import { describeTool } from "./tool-view.js";

/**
 * Tool-heavy runs can produce hundreds of calls between replies. This stays a
 * single bounded request, while finished runs outside the window fall back to
 * their stored tldr in the rail.
 */
const SEED_LIMIT = 600;

/** Server-side filter for events that can produce a useful rail preview. */
export const ACTIVITY_TYPES = [
  "session_started",
  "turn",
  "thinking",
  "tool_call",
  "tool_error",
  "question_asked",
  "question_settled",
  "ask_requested",
  "ask_received",
  "ask_settled",
  "message_received",
  "user_message_queued",
  "user_injected",
  "master_injected",
  "context_assembled",
  "images_attached",
  "driver_error",
] as const;

export type ActivityKind =
  | "reply"
  | "tool"
  | "you"
  | "thinking"
  | "question"
  | "answer"
  | "message"
  | "master"
  | "context"
  | "attachment"
  | "error";

export interface Activity {
  /** Journal id, so a live frame can never be overwritten by a stale seed. */
  eventId: number;
  kind: ActivityKind;
  /** Short semantic prefix: `reply`, `Bash`, `question`, `error`. */
  label: string;
  /** Flattened to one line; never raw payload JSON. */
  text: string;
  ts: string;
}

/** Latest meaningful activity per session id. */
export function useActivities(): ReadonlyMap<string, Activity> {
  const { api, subscribe, resyncTick } = useHarness();
  const [activities, setActivities] = useState<ReadonlyMap<string, Activity>>(
    () => new Map(),
  );

  useEffect(() => {
    let cancelled = false;
    api
      .journal({
        types: [...ACTIVITY_TYPES],
        latest: true,
        limit: SEED_LIMIT,
      })
      .then((events) => {
        if (!cancelled) setActivities((prev) => absorb(prev, events));
      })
      .catch(() => {
        // The rail falls back to `tldr`; a failed seed is not worth a banner.
      });
    return () => {
      cancelled = true;
    };
  }, [api, resyncTick]);

  useEffect(
    () =>
      subscribe((frame) => {
        if (frame.kind !== "journal") return;
        setActivities((prev) => absorb(prev, [frame.event]));
      }),
    [subscribe],
  );

  return activities;
}

/**
 * Fold journal events into the map, newest meaningful id per session wins.
 *
 * Returns the same map when nothing lands. Successful results and lifecycle
 * bookkeeping therefore do not re-render the whole rail or erase the useful
 * call/reply immediately before them.
 */
export function absorb(
  prev: ReadonlyMap<string, Activity>,
  events: readonly JournalEvent[],
): ReadonlyMap<string, Activity> {
  let next: Map<string, Activity> | null = null;
  for (const event of events) {
    const activity = activityOf(event);
    if (activity === null) continue;
    const id = event.sessionId as string;
    const held = (next ?? prev).get(id);
    if (held !== undefined && held.eventId >= event.id) continue;
    next ??= new Map(prev);
    next.set(id, activity);
  }
  return next ?? prev;
}

/** A journal event translated into the one fact worth showing in the rail. */
export function activityOf(event: JournalEvent): Activity | null {
  const payload = record(event.payload);
  const make = (
    kind: ActivityKind,
    label: string,
    value: unknown,
  ): Activity | null => {
    const text = plain(textOf(value));
    return text.length === 0
      ? null
      : { eventId: event.id, kind, label, text, ts: event.ts };
  };

  switch (event.type) {
    case "session_started": {
      const task = textOf(payload.task);
      const count = imageCount(payload.images);
      return make(
        "you",
        "you",
        task || (count > 0 ? imageLabel(count) : "session started"),
      );
    }
    case "turn":
      return make("reply", "reply", payload.text ?? event.payload);
    case "thinking":
      return make("thinking", "thinking", payload.text);
    case "tool_call": {
      const tool = describeTool(event.type, event.payload);
      return make("tool", tool.name, tool.preview || tool.caption || "called");
    }
    case "tool_error": {
      const tool = describeTool(event.type, event.payload);
      return make("error", `${tool.name} failed`, tool.preview || "tool failed");
    }
    case "question_asked": {
      const questions = Array.isArray(payload.questions) ? payload.questions : [];
      const first = record(questions[0]).question;
      return make("question", "question", first ?? "waiting for your answer");
    }
    case "question_settled":
      return make("answer", "answer", outcomeText(payload));
    case "ask_requested":
      return make(
        "question",
        typeof payload.to === "string" ? `asked ${payload.to}` : "asked sibling",
        payload.question,
      );
    case "ask_received":
      return make(
        "question",
        typeof payload.from === "string" ? `${payload.from} asked` : "sibling asked",
        payload.question,
      );
    case "ask_settled":
      return make(
        "answer",
        typeof payload.from === "string" ? `${payload.from} answered` : "sibling answered",
        outcomeText(payload),
      );
    case "message_received":
      return make(
        "message",
        typeof payload.from === "string" ? `from ${payload.from}` : "message",
        payload.message,
      );
    case "user_message_queued": {
      const count = imageCount(payload.images);
      return make(
        "you",
        "you · pending",
        textOf(payload.text) || (count > 0 ? imageLabel(count) : ""),
      );
    }
    case "user_injected": {
      const kind = textOf(payload.kind);
      const count = imageCount(payload.images);
      const value = textOf(payload.text) || (count > 0 ? imageLabel(count) : "");
      if (kind === "master_update") return make("master", "master", value);
      if (kind === "ask") return make("question", "sibling asked", value);
      if (kind === "message") return make("message", "message", value);
      return make("you", "you", value);
    }
    case "master_injected":
      return make("master", "master", payload.text ?? event.payload);
    case "context_assembled": {
      const facts = [
        typeof payload.model === "string" ? payload.model : "",
        Array.isArray(payload.tools) ? `${payload.tools.length} tools` : "",
      ].filter(Boolean);
      return make("context", "context", facts.join(" · ") || "assembled");
    }
    case "images_attached": {
      const count = imageCount(payload.images) || imageCount([payload]);
      return make("attachment", "attached", imageLabel(count));
    }
    case "driver_error":
      return make("error", "error", payload.error ?? event.payload);
    default:
      return null;
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function imageCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function imageLabel(count: number): string {
  return `${count} image${count === 1 ? "" : "s"}`;
}

function outcomeText(payload: Record<string, unknown>): string {
  if (typeof payload.text === "string") return payload.text;
  if (typeof payload.reason === "string") return payload.reason;
  const answers = record(payload.answers);
  const selected = Object.values(answers)
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter((value): value is string => typeof value === "string");
  if (selected.length > 0) return selected.join(" · ");
  const kind = textOf(payload.kind);
  return kind.length > 0 ? kind : "settled";
}

/**
 * Markdown flattened to one line of prose.
 *
 * A preview gets two lines in a narrow column, and raw markdown spends them on
 * syntax. Fenced code goes entirely; everything else keeps its text and loses
 * its marks. Underscores remain because snake_case identifiers are common.
 */
export function plain(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^[ \t]{0,3}(?:#{1,6}[ \t]+|[-*+][ \t]+|\d+[.)][ \t]+|>[ \t]?)/gm, "")
    .replace(/(\*\*\*|\*\*|\*|~~)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
}
