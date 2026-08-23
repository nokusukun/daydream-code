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

/** Placeholder for content that cannot survive durable JSON (images, etc.). */
export interface MarkerPart {
  type: "marker";
  text: string;
}

export type MessagePart = TextPart | ToolCallPart | ToolResultPart | MarkerPart;

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

export type SessionStatus = "running" | "completed" | "failed" | "killed";

export interface SessionRecord {
  id: SessionId;
  projectId: ProjectId;
  threadId: ThreadId;
  title: string | null;
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

export interface SessionResult {
  summary: string;
  tldr: string;
  usage: Usage;
}

// ---------------------------------------------------------------------------
// Projects

export interface ProjectConfig {
  /** Master-thread compaction budget in tokens. */
  masterBudgetTokens: number;
  /** Verbatim tail kept out of tier-2 compaction. */
  masterKeepTokens: number;
  /** Default driver id for dispatches. */
  defaultDriver: string;
  /** Default model id, passed through to the driver. */
  defaultModel: string | null;
}

export const defaultProjectConfig = (): ProjectConfig => ({
  masterBudgetTokens: 50_000,
  masterKeepTokens: 10_000,
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
