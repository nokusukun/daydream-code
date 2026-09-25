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
    /**
     * @mode emit — after a plan's row is committed with its planner linked.
     * A planner can write cards before this fires, since its first tool call
     * may land before its dispatch resolves. A listener may therefore see
     * cards whose `planId` it does not know yet.
     */
    "board/planned"(plan: BoardPlan): void;
    /**
     * @mode emit — after a Done card's `seenAt` is committed. Separate from
     * `board/moved` because nothing moved: a mirror of the board wants the new
     * card, but a listener narrating moves (the master thread) would announce
     * the card as done a second time.
     */
    "board/seen"(card: BoardCard): void;
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
 * Only Working sessions may be blockers, and only a card ahead in queue order
 * that has not started (Queued, Evaluating, Blocked) may be deferred to. The
 * provider enforces both, not the prompt. A defer holds until its target
 * starts or leaves the queue. "Ahead" is re-checked on every pump, so a
 * reorder cannot leave two cards waiting on each other.
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
  /**
   * The plan that wrote this card, if a planner did. Kept after the card
   * leaves Drafts, so a card on the board can still point back to the plan
   * it came from. From then on only a person can change the card.
   */
  planId: string | null;
  /**
   * When a person first looked at the card's result after it last reached
   * Done. Cleared every time the card reaches Done, so a Done card with null
   * here is unread. Outside Done it is left over from an earlier round and
   * means nothing. Kept apart from `updatedAt`, which is the card's "finished
   * 2h ago": reading a result must not make it look freshly finished.
   */
  seenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A Done card whose result nobody has looked at yet. */
export function isUnread(card: Pick<BoardCard, "column" | "seenAt">): boolean {
  return card.column === "done" && card.seenAt === null;
}

/**
 * Many draft cards written by one planner session from one large prompt. The
 * person reviews the cards, edits them by hand or asks the planner to change
 * them, and queues the plan as a whole.
 */
export interface BoardPlan {
  id: string;
  /** The planner. Null only while it is being dispatched. */
  sessionId: SessionId | null;
  /** From the person's prompt. The planner thread's own title moves on with the conversation. */
  title: string;
  /** The agent each card the planner writes will run on. */
  request: CardRequest;
  createdAt: string;
}

export interface BeginPlanInput {
  title: string;
  /** The planner's dispatch. The board puts the plan's title and marker above its task. */
  planner: DispatchRequest;
  /** The agent the planner's cards will run on. */
  cards: CardRequest;
}

export interface CreateCardInput {
  task: string;
  /** Omit to derive from `task`, the way every other card is titled. */
  title?: string;
  request?: CardRequest;
  /** Land in Drafts instead of Queued. */
  draft?: boolean;
  /** The plan writing this card. The card lands in Drafts regardless of `draft`. */
  planId?: string;
}

export interface CardPatch {
  task?: string;
  /**
   * Omit to keep the title in step with the task. A title that was derived
   * from the old task is derived again; one that was set explicitly is kept.
   */
  title?: string;
  request?: CardRequest;
}

export type BoardErrorCode =
  | "not-found"
  | "illegal-move"
  | "not-evaluator"
  | "bad-blocker"
  | "bad-defer"
  | "not-planner";

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
  /**
   * Draft → Queued for several cards at once, keeping their order relative
   * to each other, then one pump. Ids that are not drafts (any more) are
   * skipped rather than refused: the caller is queuing what it saw, and a
   * draft that was queued, cancelled or rewritten into a plan in between is
   * already dealt with. Returns the cards that moved.
   */
  abstract submitMany(ids: readonly string[]): BoardCard[];
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
   * A person has looked at a Done card's result. Idempotent, and a no-op
   * off Done rather than a refusal: the client that reports it is racing
   * the card, and a follow-up can re-queue the card between the person
   * opening its thread and the report arriving.
   */
  abstract markSeen(id: string): BoardCard;

  abstract listPlans(): BoardPlan[];
  abstract getPlan(id: string): BoardPlan | undefined;
  /** The plan a session is the planner of, if it is one. */
  abstract planFor(sessionId: SessionId): BoardPlan | undefined;
  /** A plan's cards, every column, in queue order. */
  abstract planCards(planId: string): BoardCard[];
  /**
   * Create a plan and dispatch its planner. Like `beginEvaluation`, the board
   * makes the dispatch itself so that its own intercept lets it through.
   * Otherwise the planner would become a card.
   */
  abstract beginPlan(input: BeginPlanInput): Promise<{ plan: BoardPlan; handle: SessionHandle }>;
  /**
   * Queue every draft of a plan, keeping the plan's order, at the back of the
   * queue. The back and not their old places, because the cards were written
   * when the plan was started, and a plan reviewed for an hour must not jump
   * ahead of work queued in that hour.
   */
  abstract submitPlan(planId: string): BoardCard[];
  /** Cancel every draft of a plan. Cards already queued are left alone. */
  abstract discardPlan(planId: string): BoardCard[];

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
