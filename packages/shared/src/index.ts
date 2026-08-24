/**
 * Shared vocabulary for daydream-code. Types only — no runtime dependencies
 * beyond brand helpers. Seam definitions live with their capability families;
 * this package owns the words they share.
 */

// ---------------------------------------------------------------------------
// Branded ids

declare const brand: unique symbol;
export type Branded<T, B extends string> = T & { readonly [brand]: B };

export type ProjectId = Branded<string, "ProjectId">;
export type ThreadId = Branded<string, "ThreadId">;
export type SessionId = Branded<string, "SessionId">;

export const ProjectId = (value: string): ProjectId => value as ProjectId;
export const ThreadId = (value: string): ThreadId => value as ThreadId;
export const SessionId = (value: string): SessionId => value as SessionId;

export function newId(prefix: string): string {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  let random = "";
  for (let i = 0; i < 16; i++) {
    random += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `${prefix}_${Date.now().toString(32)}${random}`;
}

/**
 * Words that carry no identifying weight in a task description. Dropped when
 * slugging so `"fix the failing tests"` names a session `fix-failing-tests`
 * rather than `fix-the-failing`.
 */
const SLUG_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "to", "of", "in", "on", "at", "for",
  "with", "from", "by", "is", "are", "was", "be", "it", "its", "this", "that",
  "these", "those", "as", "into", "out", "up", "so", "then", "than", "please",
  "can", "could", "would", "should", "we", "i", "you", "my", "our",
]);

/**
 * Derive a human-readable name from free text: lowercase, punctuation
 * stripped, stopwords dropped, first few significant words joined with `-`.
 * Deterministic and never empty — the caller is responsible for uniqueness.
 */
export function slugifyName(text: string, maxWords = 4): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, " ")
    .split(/[\s-]+/)
    .filter((word) => word.length > 0);
  const significant = words.filter((word) => !SLUG_STOPWORDS.has(word));
  // All-stopword tasks ("do it for me") still deserve a name; fall back to the
  // raw words before giving up on the generic one.
  const chosen = (significant.length > 0 ? significant : words).slice(0, maxWords);
  // Slice can land mid-word; drop the ragged tail so names never end in `-`.
  const slug = chosen.join("-").slice(0, 48).replace(/-+$/, "");
  return slug.length > 0 ? slug : "session";
}

/**
 * First free variant of `base`, suffixing `-2`, `-3`, … until `isTaken` says
 * no. Shared by dispatch and the backfill migration so both number the same way.
 */
export function uniqueName(
  base: string,
  isTaken: (candidate: string) => boolean,
): string {
  if (!isTaken(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!isTaken(candidate)) return candidate;
  }
}

/**
 * A one-line human title for an instruction: first sentence of the first
 * non-empty line, trailing punctuation dropped, capped. Never empty.
 *
 * This is the mechanical floor — the summarizer seam owns titling and a
 * model-backed provider can do better, but every provider needs a fallback
 * that cannot fail, and the backfill migration needs one with no seam at hand.
 */
export function titleFromTask(text: string, max = 72): string {
  const line =
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  const sentence = line.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? line;
  const trimmed = sentence.replace(/[\s.!?,;:]+$/, "");
  if (trimmed.length === 0) return "untitled session";
  return trimmed.length <= max
    ? trimmed
    : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// Model messages (provider-neutral, durable shape)

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface TextPart {
  type: "text";
  text: string;
}

export interface ToolCallPart {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface ToolResultPart {
  type: "tool_result";
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError?: boolean;
}

/**
 * An image attached to a message. The bytes live in the blob store, not in
 * the thread row: a base64 payload here would bloat `message_json`, pollute
 * `journal.search` (which LIKEs over raw JSON), and wreck token estimates.
 * `blobId` resolves to an on-disk path via `ctx.blobs`.
 */
export interface ImagePart {
  type: "image";
  /** Content-addressed blob id, `<sha256>.<ext>`. */
  blobId: string;
  /** IANA media type sniffed from the bytes, e.g. `image/png`. */
  mediaType: string;
  /** Pixel dimensions when readable — the basis for token estimation. */
  width?: number;
  height?: number;
  /** Original filename, for display. */
  alt?: string;
}

/** Placeholder for content that cannot survive durable JSON. */
export interface MarkerPart {
  type: "marker";
  text: string;
}

export type MessagePart =
  | TextPart
  | ImagePart
  | ToolCallPart
  | ToolResultPart
  | MarkerPart;

export interface ModelMessage {
  role: MessageRole;
  content: string | MessagePart[];
}

// ---------------------------------------------------------------------------
// Usage / cost

export interface Usage {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export const zeroUsage = (): Usage => ({ tokensIn: 0, tokensOut: 0, costUsd: 0 });

export function addUsage(a: Usage, b: Partial<Usage>): Usage {
  return {
    tokensIn: a.tokensIn + (b.tokensIn ?? 0),
    tokensOut: a.tokensOut + (b.tokensOut ?? 0),
    costUsd: a.costUsd + (b.costUsd ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Journal events (append-only; the type vocabulary is open — plugins may add
// their own durable types, but anything model-visible must be journaled)

export type JournalEventType =
  | "session_started"
  | "turn"
  | "thinking"
  | "tool_call"
  | "tool_result"
  | "tool_error"
  | "permission_request"
  | "question_asked"
  | "question_settled"
  | "ask_requested"
  | "ask_received"
  | "ask_settled"
  | "user_injected"
  | "master_injected"
  | "context_assembled"
  | "compaction"
  | "driver_error"
  | "session_ended"
  | (string & {});

export interface JournalEventInput {
  sessionId: SessionId;
  type: JournalEventType;
  payload: unknown;
  usage?: Partial<Usage>;
  ts?: string;
}

export interface JournalEvent extends JournalEventInput {
  id: number;
  ts: string;
}

// ---------------------------------------------------------------------------
// Threads

export type ThreadKind = "master" | "session";

export type ThreadEntryKind =
  | "message"
  | "compaction"
  | "session_dispatch"
  | "session_turn_end"
  | "session_summary"
  | "session_message"
  | "note";

export interface ThreadEntryInput {
  threadId: ThreadId;
  kind: ThreadEntryKind;
  message: ModelMessage;
  sessionId?: SessionId;
  toSessionId?: SessionId | null;
  /** For kind=compaction: this entry summarizes all entries with seq <= this. */
  supersedesThroughSeq?: number;
  tokenEstimate?: number;
}

export interface ThreadEntry extends ThreadEntryInput {
  id: number;
  seq: number;
  tokenEstimate: number;
  createdAt: string;
}

export interface Thread {
  id: ThreadId;
  projectId: ProjectId;
  kind: ThreadKind;
  forkedFromThread: ThreadId | null;
  forkedAtSeq: number | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Sessions

/**
 * `waiting` means the session is blocked inside a tool call on a question it
 * cannot answer itself — either one for the user (`ask_user`) or one put to a
 * sibling session (`ask_session`). It is a live status, not a terminal one:
 * the driver subprocess is still up and the turn resumes the moment it is
 * answered. Nothing behind it is durable, which is why the boot repair treats
 * a `waiting` row left by a dead process as killed.
 */
export type SessionStatus =
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "killed";

/** Statuses where a run is still in flight and the row must not be reaped. */
export const LIVE_STATUSES: readonly SessionStatus[] = ["running", "waiting"];

export interface SessionRecord {
  id: SessionId;
  projectId: ProjectId;
  threadId: ThreadId;
  /** Human-readable handle, unique per project. Accepted anywhere an id is. */
  name: string;
  /**
   * One-line description of what the session is working on *now*. Unlike
   * `name`, this is re-derived whenever the current task changes, so it is
   * display-only — never an address.
   */
  title: string;
  /** The instruction the session was dispatched with. */
  task: string;
  driver: string;
  modelId: string | null;
  status: SessionStatus;
  lastSeenMasterSeq: number;
  startedAt: string;
  endedAt: string | null;
  summary: string | null;
  tldr: string | null;
  usage: Usage;
}

/**
 * When a session last did something: the moment it finished, or — while it is
 * still live — the moment it started. `endedAt` is cleared on every continue
 * and re-stamped on every finish, so this tracks the latest turn rather than
 * the original dispatch.
 *
 * ISO-8601 UTC strings sort lexicographically, so this is usable as a SQL
 * `ORDER BY` key and as a JS comparator key without parsing.
 */
export function sessionActivityAt(
  session: Pick<SessionRecord, "startedAt" | "endedAt">,
): string {
  return session.endedAt ?? session.startedAt;
}

/**
 * Most recent first, for every list of sessions a human reads. Ties break on
 * name so the order is total and a re-render never reshuffles equal rows.
 */
export function compareSessionRecency(
  a: Pick<SessionRecord, "startedAt" | "endedAt" | "name">,
  b: Pick<SessionRecord, "startedAt" | "endedAt" | "name">,
): number {
  const at = sessionActivityAt(a);
  const bt = sessionActivityAt(b);
  if (at !== bt) return at < bt ? 1 : -1;
  return a.name.localeCompare(b.name);
}

export interface SessionResult {
  summary: string;
  tldr: string;
  usage: Usage;
}

// ---------------------------------------------------------------------------
// Projects

/**
 * Per-project settings that live in the database rather than in a config
 * layer, because they are chosen in the UI and belong to the project rather
 * than to the machine or the checkout.
 *
 * Compaction budgets deliberately do *not* live here. They used to, and were
 * read by nothing: the compactor takes its budget from its own plugin config,
 * which is the seam a replacement compactor would also be configured through.
 * Two spellings of one setting is worse than one, so the dead pair is gone.
 */
export interface ProjectConfig {
  /** Default driver id for dispatches. */
  defaultDriver: string;
  /** Default model id, passed through to the driver. */
  defaultModel: string | null;
}

export const defaultProjectConfig = (): ProjectConfig => ({
  defaultDriver: "claude",
  defaultModel: null,
});

export interface ProjectRecord {
  id: ProjectId;
  name: string;
  rootPath: string;
  config: ProjectConfig;
  createdAt: string;
}

export function nowIso(): string {
  return new Date().toISOString();
}
