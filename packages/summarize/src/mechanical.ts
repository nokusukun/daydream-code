import { titleFromTask, type JournalEvent } from "@daydream-code/shared";
import {
  Summarizer,
  type SessionSummaryInput,
  type TitleInput,
  type TurnSummaryInput,
} from "./index.js";

/**
 * Deterministic, model-free summarizer. Builds digests purely from journal
 * facts — event texts, tool names, path-ish arguments — and never interprets.
 * Guaranteed fallback provider; also used for crash-recovery write-backs.
 */
export default class MechanicalSummarizer extends Summarizer {
  async title({ task }: TitleInput): Promise<string> {
    return titleFromTask(task);
  }

  async turnSummary({ turnEvents }: TurnSummaryInput): Promise<string> {
    if (turnEvents.length === 0) return "turn ended (no events recorded)";
    const turns = turnEvents.filter((e) => e.type === "turn");
    const last = turns[turns.length - 1];
    const text = last ? firstSentence(payloadText(last.payload)) : "";
    const counts = toolCounts(turnEvents);
    const parts: string[] = [];
    parts.push(text || "turn ended (no turn text)");
    if (counts.size > 0) parts.push(`(${formatCounts(counts)})`);
    return truncate(parts.join(" "), 200);
  }

  async sessionSummary({
    session,
    events,
    reason,
  }: SessionSummaryInput): Promise<{ summary: string; tldr: string }> {
    if (events.length === 0) {
      const summary = [
        `Session ${session.id} ended abruptly (${reason}); no journal events were recorded.`,
        `Task: ${session.task}`,
        "Facts only; no interpretation.",
      ].join("\n");
      return { summary, tldr: session.task.slice(0, 120) };
    }

    const turns = events.filter((e) => e.type === "turn");
    const lastTurn = turns[turns.length - 1];
    const finalText = lastTurn ? payloadText(lastTurn.payload) : "";

    const files = new Set<string>();
    for (const e of events) {
      if (e.type === "tool_call") collectPaths(e.payload, files);
    }
    const counts = toolCounts(events);

    const summary = [
      `Task: ${session.task}`,
      `Status: ${reason}`,
      `Files touched: ${files.size > 0 ? [...files].join(", ") : "none detected"}`,
      `Tool calls: ${counts.size > 0 ? formatCounts(counts) : "none"}`,
      `Turns: ${turns.length}`,
      `Final: ${finalText ? truncate(finalText, 500) : "(no turn text recorded)"}`,
      "Facts only; no interpretation.",
    ].join("\n");

    return { summary, tldr: (finalText || session.task).slice(0, 120) };
  }
}

// ---------------------------------------------------------------------------
// Mechanical extraction helpers (no interpretation, just structure walking)

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** First non-empty line, cut at the first sentence boundary if it has one. */
function firstSentence(text: string): string {
  const line =
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  const match = line.match(/^.*?[.!?](?=\s|$)/);
  return match ? match[0] : line;
}

/** Best-effort human text of a journal event payload. */
function payloadText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (payload === null || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  for (const key of ["text", "summary", "content"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  if (Array.isArray(record["content"])) {
    const texts = record["content"]
      .map((part) =>
        part !== null &&
        typeof part === "object" &&
        typeof (part as { text?: unknown }).text === "string"
          ? ((part as { text: string }).text)
          : "",
      )
      .filter((t) => t.length > 0);
    if (texts.length > 0) return texts.join("\n");
  }
  if (record["message"] !== undefined) return payloadText(record["message"]);
  return "";
}

function toolName(payload: unknown): string {
  if (payload !== null && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    for (const key of ["toolName", "tool_name", "name", "tool"]) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return "unknown";
}

function toolCounts(events: readonly JournalEvent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of events) {
    if (e.type !== "tool_call") continue;
    const name = toolName(e.payload);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

/** `3 tool calls: bash x2, write x1` — count desc, then name asc. */
function formatCounts(counts: Map<string, number>): string {
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const list = [...counts.entries()]
    .sort(([an, ac], [bn, bc]) => bc - ac || an.localeCompare(bn))
    .map(([name, count]) => `${name} x${count}`)
    .join(", ");
  return `${total} tool call${total === 1 ? "" : "s"}: ${list}`;
}

const PATH_KEYS = new Set(["file_path", "path", "filename"]);

/** Collect string values under obvious path-ish keys, anywhere in the JSON. */
function collectPaths(value: unknown, out: Set<string>, depth = 0): void {
  if (depth > 8 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, out, depth + 1);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (PATH_KEYS.has(key) && typeof child === "string" && child.trim().length > 0) {
      out.add(child);
    } else {
      collectPaths(child, out, depth + 1);
    }
  }
}
