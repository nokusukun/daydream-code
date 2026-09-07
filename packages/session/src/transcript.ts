/**
 * Rebuild a session's own conversation from its journal.
 *
 * The journal is the only harness-side record of what a thread said: the
 * drivers keep the real transcript provider-side behind a resume token, and
 * that token is redeemable only by the provider that minted it. The moment a
 * thread changes agents — or hands its work to a new thread — someone has to
 * reconstruct "what happened so far" from what was journaled. This module is
 * that reconstruction, in two renderings: `transcriptMessages` for seeding a
 * switched driver's context, `transcriptText` for embedding in a handoff task.
 *
 * Deliberately lossy. Thinking blocks are private to the model that thought
 * them, master-thread updates were addressed to the *old* run and arrive again
 * through master-inject anyway, and tool payloads are clipped — the point is
 * continuity, not replay.
 */
import type {
  ImagePart,
  JournalEvent,
  ModelMessage,
} from "@daydream-code/shared";

export interface EditableMessage {
  eventId: number;
  message: string;
  images: ImagePart[];
}

interface TranscriptLine {
  role: "user" | "assistant";
  text: string;
}

/** Characters, not tokens: this runs where no tokenizer is guaranteed. */
export const TRANSCRIPT_BUDGET = 24_000;
const PAYLOAD_EXCERPT = 240;

function clipText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function excerpt(value: unknown): string {
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return clipText(text ?? "", PAYLOAD_EXCERPT);
}

function asRecord(payload: unknown): Record<string, unknown> {
  return typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function images(value: unknown): ImagePart[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ImagePart => {
    if (typeof item !== "object" || item === null) return false;
    const image = item as Record<string, unknown>;
    return (
      image.type === "image" &&
      typeof image.blobId === "string" &&
      typeof image.mediaType === "string"
    );
  });
}

/**
 * The journal rows on the active conversation branch.
 *
 * Checkpointing never mutates the append-only journal. Its marker points at
 * the user message being replaced; folding that marker removes the abandoned
 * tail from model context while leaving every original row available to the
 * transcript and journal search.
 */
export function activeTranscriptEvents(
  events: readonly JournalEvent[],
): JournalEvent[] {
  let active: JournalEvent[] = [];
  for (const event of events) {
    if (event.type !== "session_checkpoint") {
      active.push(event);
      continue;
    }
    const fromEventId = asRecord(event.payload).fromEventId;
    if (typeof fromEventId !== "number" || !Number.isInteger(fromEventId)) {
      continue;
    }
    active = active.filter((candidate) => candidate.id < fromEventId);
  }
  return active;
}

/** The newest user-authored message on the active branch, if it is editable. */
export function lastEditableMessage(
  events: readonly JournalEvent[],
): EditableMessage | null {
  const active = activeTranscriptEvents(events);
  for (let index = active.length - 1; index >= 0; index -= 1) {
    const event = active[index]!;
    const payload = asRecord(event.payload);
    const editable =
      event.type === "session_started" ||
      event.type === "user_message_queued" ||
      (event.type === "user_injected" && payload.kind === "user");
    if (!editable) continue;
    const message = typeof payload.task === "string"
      ? payload.task
      : typeof payload.text === "string"
        ? payload.text
        : "";
    const attached = images(payload.images);
    if (message.length === 0 && attached.length === 0) continue;
    return { eventId: event.id, message, images: attached };
  }
  return null;
}

/**
 * One journal event → zero or one transcript lines.
 *
 * Payloads are read defensively rather than through declared types: the
 * journal's vocabulary is open and old rows outlive the code that wrote them,
 * so a shape that does not match simply contributes nothing.
 */
function lineFor(event: JournalEvent): TranscriptLine | null {
  const payload = asRecord(event.payload);
  switch (event.type) {
    case "session_started": {
      const task = str(payload.task);
      return task ? { role: "user", text: task } : null;
    }
    case "user_injected": {
      // Master-thread updates are re-injected into the next run regardless;
      // replaying them here would say everything twice.
      if (payload.kind === "master_update") return null;
      const text = str(payload.text);
      if (text === undefined) return null;
      return {
        role: "user",
        text:
          payload.kind === "user" ? text : `[from a sibling thread] ${text}`,
      };
    }
    case "turn": {
      const text = str(payload.text);
      return text ? { role: "assistant", text } : null;
    }
    case "tool_call": {
      const name = str(payload.name) ?? "tool";
      return {
        role: "assistant",
        text: `[tool_call ${name} ${excerpt(payload.args)}]`,
      };
    }
    case "tool_result": {
      const label = payload.isError === true ? "tool_error" : "tool_result";
      return { role: "assistant", text: `[${label} ${excerpt(payload.result)}]` };
    }
    case "driver_error": {
      const error = str(payload.error);
      return error
        ? { role: "assistant", text: `[driver error: ${clipText(error, PAYLOAD_EXCERPT)}]` }
        : null;
    }
    case "session_ended": {
      const status = str(payload.status) ?? "ended";
      const tldr = str(payload.tldr);
      return {
        role: "assistant",
        text: `[run ${status}${tldr ? `: ${clipText(tldr, PAYLOAD_EXCERPT)}` : ""}]`,
      };
    }
    default:
      return null;
  }
}

/**
 * The tail of the transcript that fits `budget`, oldest first.
 *
 * The tail rather than the head because a handoff continues from where the
 * thread *is*; when anything is dropped, the first line says so instead of
 * letting the reader mistake the cut for the beginning.
 */
export function transcriptLines(
  events: readonly JournalEvent[],
  budget: number = TRANSCRIPT_BUDGET,
): TranscriptLine[] {
  const all: TranscriptLine[] = [];
  for (const event of activeTranscriptEvents(events)) {
    const line = lineFor(event);
    if (line !== null) all.push(line);
  }
  let spent = 0;
  let start = all.length;
  while (start > 0) {
    const next = all[start - 1]!;
    if (spent + next.text.length > budget && start < all.length) break;
    // A single oversized line still ships, clipped, so a thread whose last
    // event is one huge tool result does not hand off an empty transcript.
    spent += next.text.length;
    start -= 1;
  }
  const kept = all.slice(start).map((line) => ({
    ...line,
    text: clipText(line.text, budget),
  }));
  if (start > 0 && kept.length > 0) {
    kept.unshift({
      role: "user",
      text: `[${start} earlier transcript entr${start === 1 ? "y" : "ies"} elided to fit the context budget]`,
    });
  }
  return kept;
}

/**
 * The transcript as context messages, consecutive same-role lines merged so a
 * burst of tool calls reads as one assistant message rather than twenty.
 */
export function transcriptMessages(
  events: readonly JournalEvent[],
  budget: number = TRANSCRIPT_BUDGET,
): ModelMessage[] {
  const messages: ModelMessage[] = [];
  for (const line of transcriptLines(events, budget)) {
    const last = messages[messages.length - 1];
    if (last !== undefined && last.role === line.role && typeof last.content === "string") {
      last.content = `${last.content}\n${line.text}`;
    } else {
      messages.push({ role: line.role, content: line.text });
    }
  }
  return messages;
}

/** The transcript as prose, for embedding in a handoff task. */
export function transcriptText(
  events: readonly JournalEvent[],
  budget: number = TRANSCRIPT_BUDGET,
): string {
  return transcriptMessages(events, budget)
    .map((message) => `[${message.role}]\n${String(message.content)}`)
    .join("\n\n");
}
