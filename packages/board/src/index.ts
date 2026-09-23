import { Service, type Context } from "@daydream-code/kernel";
import type { ProjectId, SessionId } from "@daydream-code/shared";
import type {
  AttachmentInput,
  DispatchRequest,
  SessionHandle,
} from "@daydream-code/session";

declare module "@daydream-code/kernel" {
  interface Context {
    board: Board;
  }
  interface Events {
    /**
     * @mode emit — after a card's row is committed with a new column (or a
     * new row exists: `from` is then null). Also fired for a re-queue that
     * lands in the column the card was already in, so a listener that mirrors
     * the board (the stream, the master thread) sees every write.
     */
    "board/moved"(card: BoardCard, from: BoardColumn | null): void;
    /** @mode emit — after the card's row and its blocks are gone. */
    "board/removed"(card: BoardCard): void;
  }
}

/**
 * The columns, in board order.
 *
 * `blocked` is a real column in storage even though the UI draws it inside
 * Queued: "waiting for its turn" and "waiting on named sessions" have
 * different exits, and a state that has to be inferred from a join is the
 * kind that drifts.
 */
export type BoardColumn =
  | "draft"
  | "queued"
  | "evaluating"
  | "blocked"
  | "working"
  | "attention"
  | "done";

export const BOARD_COLUMNS: readonly BoardColumn[] = [
  "draft",
  "queued",
  "evaluating",
  "blocked",
  "working",
  "attention",
  "done",
];

/**
 * Everything about a dispatch except the task. Kept verbatim on the card so
 * the session it eventually starts is the one the person asked for, however
 * long the card waited. Attachments are blob references by the time they
 * land here: a card can wait for hours, and a base64 payload in a row that is
 * read on every board refresh is the same mistake `drafts.ts` avoids.
 */
export interface CardRequest {
  driver?: string;
  modelId?: string;
  effort?: string;
  fastMode?: boolean;
  name?: string;
  attachments?: AttachmentInput[];
  permissionMode?: "auto" | "ask" | "readonly";
}

export interface BoardBlock {
  blockerSessionId: SessionId;
  /** Display name of the blocker, resolved when the card is read. */
  blockerName: string;
  source: "evaluator" | "user";
  reason: string | null;
  createdAt: string;
}

/**
 * What the evaluator decided. `block` names sessions; `defer` names a card.
 * Only Working sessions may be blockers and only an Evaluating card ahead in
 * queue order may be deferred to — both enforced by the provider, not the
 * prompt — which is what keeps two parallel evaluations from each blocking
 * on the other.
 */
export type Verdict =
  | { decision: "proceed"; reason: string; at: string }
  | { decision: "block"; reason: string; blockedBy: string[]; at: string }
  | { decision: "defer"; reason: string; deferTo: string; at: string };

export type VerdictInput =
  | { decision: "proceed"; reason: string }
  | { decision: "block"; reason: string; blockedBy: string[] }
  | { decision: "defer"; reason: string; deferTo: string };

export interface BoardCard {
  id: string;
  projectId: ProjectId;
  column: BoardColumn;
  /** Order within the queue; lower runs first. Fractional after a reorder. */
  position: number;
  /** `titleFromTask` until a session exists, then the session's own title. */
  title: string;
  /** The opening instruction, or the pending follow-up for a re-queued card. */
  task: string;
  request: CardRequest;
  /** Null until the card is Working for the first time. */
  sessionId: SessionId | null;
  /** The session evaluating (or that last evaluated) this card. */
  evaluatorSessionId: SessionId | null;
  blockedBy: BoardBlock[];
  /** Why it sits in Needs Attention; null elsewhere. */
  attentionReason: string | null;
  verdict: Verdict | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCardInput {
  task: string;
  request?: CardRequest;
  /** Land in Drafts instead of Queued. */
  draft?: boolean;
}

export interface CardPatch {
  task?: string;
  request?: CardRequest;
}

export type BoardErrorCode =
  | "not-found"
  | "illegal-move"
  | "not-evaluator"
  | "bad-blocker"
  | "bad-defer";

/**
 * A refused board operation. `code` is what a route maps to a status and what
 * the evaluator's tool turns into guidance the model can act on.
 */
export class BoardError extends Error {
  constructor(
    readonly code: BoardErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BoardError";
  }
}

/**
 * Exclusive seam: the kanban board. Cards move through fixed columns; the
 * provider owns the state machine, the queue order, and the two intercepts
 * that turn every new session in the project into a card.
 *
 * Evaluation is split off: the provider moves a card into Evaluating and
 * emits `board/moved`; a separate evaluator plugin decides what happens
 * there and reports back through `verdict`. That is the seam a different
 * evaluation strategy (a mechanical one, a cheaper model) plugs into.
 */
export abstract class Board extends Service {
  constructor(ctx: Context) {
    super(ctx, "board");
  }

  abstract list(): BoardCard[];
  abstract get(id: string): BoardCard | undefined;
  /** The card a work session belongs to, if it belongs to one. */
  abstract forSession(sessionId: SessionId): BoardCard | undefined;
  /** The card a session is evaluating, if it is an evaluator. */
  abstract forEvaluator(sessionId: SessionId): BoardCard | undefined;

  abstract create(input: CreateCardInput): BoardCard;
  /** Drafts and Queued only: a card that has been evaluated is what it is. */
  abstract update(id: string, patch: CardPatch): BoardCard;
  /** Draft → Queued. */
  abstract submit(id: string): BoardCard;
  /** Move before another card, or to the tail with `null`. */
  abstract reorder(id: string, before: string | null): BoardCard;
  /** Force start: skip or abandon evaluation, drop blockers, run now. */
  abstract start(id: string): Promise<BoardCard>;
  /** Replace the blocker set by hand. Empty releases the card. */
  abstract setBlockers(
    id: string,
    blockers: Array<{ sessionId: SessionId; reason?: string }>,
  ): BoardCard;
  /** Drafts, Queued and Blocked only. */
  abstract cancel(id: string): BoardCard;

  /**
   * Dispatch the evaluator session for a card in Evaluating. The board makes
   * the dispatch itself so that its own intercept lets it through, and so
   * the card can be linked to the evaluator before anything else observes it.
   */
  abstract beginEvaluation(
    id: string,
    request: DispatchRequest,
  ): Promise<SessionHandle>;
  /**
   * The evaluator's decision. `from` must be the card's evaluator session;
   * anything else is refused, because a verdict is the one write that moves
   * a card without a person's hand on it.
   */
  abstract verdict(
    id: string,
    verdict: VerdictInput,
    from: SessionId,
  ): Promise<BoardCard>;
}
