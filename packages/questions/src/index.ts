import { Service, type Context } from "@daydream-code/kernel";
import { newId, nowIso, type SessionId } from "@daydream-code/shared";

declare module "@daydream-code/kernel" {
  interface Context {
    questions: Questions;
  }
  interface Events {
    /** @mode emit — a session blocked on a question. Journal it, flag the row. */
    "question/asked"(pending: PendingQuestion): void;
    /**
     * @mode emit — the block cleared, however it cleared. Fired exactly once
     * per request, always after `question/asked`.
     */
    "question/settled"(pending: PendingQuestion, outcome: QuestionOutcome): void;
  }
}

/** One selectable choice. `description` carries the tradeoff, not the label. */
export interface QuestionOption {
  label: string;
  description: string;
}

/**
 * Shape-compatible with the Claude SDK's built-in `AskUserQuestion` input, so
 * that if that tool ever becomes reachable here this is a swap rather than a
 * rewrite. (It is not reachable today: the CLI only lists it when the host
 * passes `canUseTool`, and under `bypassPermissions` — this harness's default
 * permission mode — the SDK never invokes that callback. Measured, not assumed.)
 *
 * `id` is the full question text, matching how that SDK keys answers back.
 */
export interface Question {
  id: string;
  /** Short chip label, <= 12 chars. */
  header: string;
  question: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

/** Answers keyed by question id (i.e. by question text). */
export type Answers = Record<string, string | string[]>;

export interface PendingQuestion {
  requestId: string;
  sessionId: SessionId;
  questions: Question[];
  askedAt: string;
}

/**
 * How a block cleared. Each maps to a distinct thing the model should do, so
 * they stay separate rather than collapsing into "answered or not":
 *
 * - `answered`  the user picked options — authoritative, proceed.
 * - `replied`   the user wrote prose instead of picking. Prose beats options
 *               (the same precedence t3code's client applies), and mapping it
 *               onto per-question slots would be a guess, so it is passed
 *               through verbatim for the model to read.
 * - `declined`  the user explicitly handed the decision back. Proceed with the
 *               recommended option and record it as an assumption.
 * - `cancelled` nobody is coming: the turn aborted, or the process is going
 *               down. Not a decision, and must never read as one.
 */
export type QuestionOutcome =
  | { kind: "answered"; answers: Answers }
  | { kind: "replied"; text: string }
  | { kind: "declined" }
  | { kind: "cancelled"; reason: string };

interface Waiter {
  pending: PendingQuestion;
  settle: (outcome: QuestionOutcome) => void;
}

/**
 * Registry seam for blocking questions: a tool asks and awaits, some human
 * surface answers, the tool's promise resolves and the turn continues inside
 * the same tool call.
 *
 * This is its own package on purpose. `tools` asks, `session` journals and
 * flags the row, and `server` answers — routing any of that through
 * `ctx.sessions` would make `tools` depend on `session`, which is the build
 * cycle `recall.ts` already had to dodge by querying the store directly.
 *
 * Nothing here is durable. A pending question is an in-memory promise held by
 * one process, so it cannot survive that process — see `cancelAll`, and the
 * boot repair in the session runner.
 */
export class Questions extends Service {
  #waiters = new Map<string, Waiter>();

  constructor(ctx: Context) {
    super(ctx, "questions");
    // Unloading the plugin must not strand a caller mid-await.
    ctx.effect(() => () => {
      this.cancelAll("the questions service was unloaded");
    }, "questions(release)");
  }

  /**
   * Block until somebody answers. The returned promise never rejects — a
   * caller that dies waiting is worse than one that gets `cancelled` and can
   * tell the model so.
   */
  ask(sessionId: SessionId, questions: Question[]): Promise<QuestionOutcome> {
    const pending: PendingQuestion = {
      requestId: newId("qst"),
      sessionId,
      questions,
      askedAt: nowIso(),
    };
    return new Promise<QuestionOutcome>((resolve) => {
      this.#waiters.set(pending.requestId, { pending, settle: resolve });
      // After the waiter is registered, so a listener that answers
      // synchronously (the CLI does) still finds it.
      this.ctx.emit("question/asked", pending);
    });
  }

  /** Every unanswered question, oldest first. */
  pending(sessionId?: SessionId): PendingQuestion[] {
    return [...this.#waiters.values()]
      .map((w) => w.pending)
      .filter((p) => sessionId === undefined || p.sessionId === sessionId)
      .sort((a, b) => a.askedAt.localeCompare(b.askedAt));
  }

  /** The oldest unanswered question for a session, if it is blocked. */
  current(sessionId: SessionId): PendingQuestion | undefined {
    return this.pending(sessionId)[0];
  }

  /**
   * Settle one request. Returns false if the id is unknown — which is the
   * normal outcome for an answer arriving after a restart, not a fault, so
   * callers report it rather than throwing.
   */
  settle(requestId: string, outcome: QuestionOutcome): boolean {
    const waiter = this.#waiters.get(requestId);
    if (!waiter) return false;
    this.#waiters.delete(requestId);
    waiter.settle(outcome);
    this.ctx.emit("question/settled", waiter.pending, outcome);
    return true;
  }

  /** Settle a session's oldest pending question. Returns false if it has none. */
  settleCurrent(sessionId: SessionId, outcome: QuestionOutcome): boolean {
    const pending = this.current(sessionId);
    return pending ? this.settle(pending.requestId, outcome) : false;
  }

  /**
   * Release everything a session is blocked on. Called when its run ends by
   * any path, so an aborted turn cannot leave a promise — and the driver
   * subprocess behind it — pinned forever.
   */
  cancelSession(sessionId: SessionId, reason: string): number {
    let count = 0;
    for (const pending of this.pending(sessionId)) {
      if (this.settle(pending.requestId, { kind: "cancelled", reason })) count++;
    }
    return count;
  }

  /** Release everything, for process teardown. */
  cancelAll(reason: string): number {
    let count = 0;
    for (const pending of this.pending()) {
      if (this.settle(pending.requestId, { kind: "cancelled", reason })) count++;
    }
    return count;
  }
}
