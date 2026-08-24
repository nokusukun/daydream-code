import { z } from "zod";
import { defineConfig, field } from "@daydream-code/config";
import { Service, type Context } from "@daydream-code/kernel";
import { newId, nowIso, type SessionId } from "@daydream-code/shared";

declare module "@daydream-code/kernel" {
  interface Context {
    asks: SessionAsks;
  }
  interface Events {
    /**
     * @mode emit — one session asked another and is now blocked. The runner
     * listens to journal it, flag the asker `waiting`, and *deliver* the
     * question to the target. Delivery is deliberately not done here: only the
     * runner knows whether the target is mid-turn (queue an injection) or idle
     * (start a run), and only it may touch `status`.
     */
    "ask/requested"(pending: PendingAsk): void;
    /**
     * @mode emit — the target has been reminded. `attempt` is 1-based and
     * counts reminders, not deliveries, so the first delivery is attempt 0.
     */
    "ask/nudged"(pending: PendingAsk, attempt: number): void;
    /** @mode emit — the block cleared. Fires exactly once per request. */
    "ask/settled"(pending: PendingAsk, outcome: AskOutcome): void;
  }
}

export const { Config, settings } = defineConfig({
  nudgeAfterMs: field.number({
    label: "reminder delay",
    help:
      "silence before the target session is reminded. Sized for agent turns, " +
      "not human latency: a sibling deep in a long tool call has not ignored " +
      "anything yet.",
    default: 120_000,
    integer: true,
    min: 1,
    unit: "ms",
  }),
  maxNudges: field.number({
    label: "reminder limit",
    help:
      "reminders before the asker gives up and is released as unanswered. " +
      "The cap is the point: an agent can end its turn, be killed, or simply " +
      "not care, and an unbounded wait would park the asker forever.",
    default: 3,
    integer: true,
    min: 0,
  }),
});

export type AsksConfig = z.output<typeof Config>;

export interface PendingAsk {
  requestId: string;
  /** The blocked session. */
  fromSessionId: SessionId;
  /** Display name of the asker, resolved at ask time for the prose sent on. */
  fromName: string;
  /** The session being asked. */
  toSessionId: SessionId;
  toName: string;
  question: string;
  askedAt: string;
  /** Reminders sent so far. */
  nudges: number;
}

/**
 * How the block cleared. These stay distinct because each one means something
 * different about the *answer*, and collapsing them would let the asker treat
 * a silence as a decision:
 *
 * - `answered`  the target replied. Authoritative.
 * - `declined`  the target explicitly refused or handed it back. A real
 *               response, and not the same as silence.
 * - `unanswered` reminders ran out, or the target is gone and is not coming
 *               back. Nobody decided anything.
 * - `cancelled` the *asker* is going away — its turn aborted or the process is
 *               going down. Not about the target at all.
 */
export type AskOutcome =
  | { kind: "answered"; text: string }
  | { kind: "declined"; reason: string }
  | { kind: "unanswered"; reason: string; nudges: number }
  | { kind: "cancelled"; reason: string };

/** Why an ask was refused before it ever blocked anyone. */
export type AskRefusal =
  | { reason: "self"; detail: string }
  | { reason: "cycle"; detail: string }
  | { reason: "duplicate"; detail: string };

export class AskRefused extends Error {
  constructor(readonly refusal: AskRefusal) {
    super(refusal.detail);
    this.name = "AskRefused";
  }
}

interface Waiter {
  pending: PendingAsk;
  settle: (outcome: AskOutcome) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export interface AskRequest {
  fromSessionId: SessionId;
  fromName: string;
  toSessionId: SessionId;
  toName: string;
  question: string;
}

/**
 * Registry seam for session-to-session questions: one session asks, blocks
 * inside its tool call, and resumes when a sibling answers.
 *
 * This is a sibling of `questions`, not a reuse of it, because the two differ
 * in every dimension that matters. A question to a human is multiple-choice,
 * answered through a UI, and may reasonably wait forever — somebody will
 * eventually look. A question to a session is open prose, answered by a tool
 * call, and must not wait forever, because the counterparty is an agent that
 * can end its turn and never come back. Bending one shape onto the other would
 * have meant an options array nobody fills in and a timeout nobody wants.
 *
 * Like `questions`, nothing here is durable: a pending ask is an in-memory
 * promise held by one process, so both sessions must live in that process and
 * neither survives its death.
 */
export class SessionAsks extends Service {
  static Config = Config;
  static settings = settings;

  readonly #config: AsksConfig;
  #waiters = new Map<string, Waiter>();

  constructor(ctx: Context, config: AsksConfig) {
    super(ctx, "asks");
    this.#config = config;
    ctx.effect(() => () => {
      this.cancelAll("the asks service was unloaded");
    }, "asks(release)");
  }

  get config(): AsksConfig {
    return this.#config;
  }

  /**
   * Block until the target answers, declines, or runs out of reminders. Like
   * `questions.ask`, the returned promise never rejects once it is handed
   * back — a caller that dies waiting is worse than one that is told nobody
   * answered. Structural refusals throw *before* anything blocks.
   */
  ask(request: AskRequest): Promise<AskOutcome> {
    this.#refuseIfUnaskable(request);
    const pending: PendingAsk = {
      requestId: newId("ask"),
      fromSessionId: request.fromSessionId,
      fromName: request.fromName,
      toSessionId: request.toSessionId,
      toName: request.toName,
      question: request.question,
      askedAt: nowIso(),
      nudges: 0,
    };
    return new Promise<AskOutcome>((resolve) => {
      this.#waiters.set(pending.requestId, {
        pending,
        settle: resolve,
        timer: this.#arm(pending.requestId),
      });
      // Registered first, so a listener that answers synchronously still finds
      // the waiter — the same ordering `questions.ask` depends on.
      this.ctx.emit("ask/requested", pending);
    });
  }

  /**
   * Reject asks that cannot possibly be answered, before they park a session.
   *
   * The cycle check is the one that earns its keep. Two sessions asking each
   * other is not exotic — it is what coordinating siblings naturally do — and
   * without this both park until their reminders run out, which reads to the
   * user as two hung sessions rather than as a mistake either of them made.
   */
  #refuseIfUnaskable(request: AskRequest): void {
    if (request.fromSessionId === request.toSessionId) {
      throw new AskRefused({
        reason: "self",
        detail: "a session cannot ask itself",
      });
    }
    const blocker = this.#pathToAsker(request.toSessionId, request.fromSessionId);
    if (blocker) {
      throw new AskRefused({
        reason: "cycle",
        detail: `${request.toName} is already blocked waiting on ${blocker}, so it cannot answer`,
      });
    }
    const already = this.outbound(request.fromSessionId).find(
      (p) => p.toSessionId === request.toSessionId,
    );
    if (already) {
      throw new AskRefused({
        reason: "duplicate",
        detail: `already waiting on ${request.toName} (${already.requestId})`,
      });
    }
  }

  /**
   * Walk the wait-for graph from `start`. Returns the name of the session that
   * closes the loop back onto `target`, or undefined if there is no loop.
   */
  #pathToAsker(start: SessionId, target: SessionId): string | undefined {
    const seen = new Set<string>();
    let cursor: SessionId | undefined = start;
    while (cursor !== undefined && !seen.has(cursor)) {
      seen.add(cursor);
      const waiting: PendingAsk | undefined = this.outbound(cursor)[0];
      if (!waiting) return undefined;
      if (waiting.toSessionId === target) return waiting.fromName;
      cursor = waiting.toSessionId;
    }
    return undefined;
  }

  #arm(requestId: string): ReturnType<typeof setTimeout> | undefined {
    if (this.#config.maxNudges === 0 && this.#config.nudgeAfterMs <= 0) {
      return undefined;
    }
    const timer = setTimeout(() => {
      this.nudge(requestId, "no reply since the last reminder");
    }, this.#config.nudgeAfterMs);
    // A pending ask must never be the reason the process stays alive.
    (timer as { unref?: () => void }).unref?.();
    return timer;
  }

  /**
   * Remind the target, or give up if it has been reminded enough. Called by
   * this service's own timer and by the runner when the target finishes a turn
   * without answering — that second trigger is the precise moment the target
   * had the question in hand and did not act on it, which no timer can know.
   */
  nudge(requestId: string, reason: string): boolean {
    const waiter = this.#waiters.get(requestId);
    if (!waiter) return false;
    if (waiter.pending.nudges >= this.#config.maxNudges) {
      this.settle(requestId, {
        kind: "unanswered",
        reason,
        nudges: waiter.pending.nudges,
      });
      return false;
    }
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.pending.nudges += 1;
    waiter.timer = this.#arm(requestId);
    this.ctx.emit("ask/nudged", waiter.pending, waiter.pending.nudges);
    return true;
  }

  /** Every unsettled ask, oldest first. */
  pending(): PendingAsk[] {
    return [...this.#waiters.values()]
      .map((w) => w.pending)
      .sort((a, b) => a.askedAt.localeCompare(b.askedAt));
  }

  /** Asks this session is blocked on. */
  outbound(sessionId: SessionId): PendingAsk[] {
    return this.pending().filter((p) => p.fromSessionId === sessionId);
  }

  /** Asks addressed to this session and still owed an answer. */
  inbound(sessionId: SessionId): PendingAsk[] {
    return this.pending().filter((p) => p.toSessionId === sessionId);
  }

  get(requestId: string): PendingAsk | undefined {
    return this.#waiters.get(requestId)?.pending;
  }

  /** Settle one request. False if the id is unknown, which is not a fault. */
  settle(requestId: string, outcome: AskOutcome): boolean {
    const waiter = this.#waiters.get(requestId);
    if (!waiter) return false;
    this.#waiters.delete(requestId);
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.settle(outcome);
    this.ctx.emit("ask/settled", waiter.pending, outcome);
    return true;
  }

  /**
   * Answer on behalf of a session, refusing if that session was not the one
   * asked. Without this check any sibling could answer for any other, and the
   * asker would have no way to tell — the outcome it receives looks identical.
   */
  answer(
    requestId: string,
    answerer: SessionId,
    outcome: AskOutcome,
  ): "settled" | "unknown" | "not-yours" {
    const waiter = this.#waiters.get(requestId);
    if (!waiter) return "unknown";
    if (waiter.pending.toSessionId !== answerer) return "not-yours";
    this.settle(requestId, outcome);
    return "settled";
  }

  /**
   * Release everything a session is blocked *on*, for when the asker itself is
   * going away. Answers owed *by* it are left alone: it may yet be continued,
   * and the runner decides whether waking it is worth a reminder.
   */
  cancelSession(sessionId: SessionId, reason: string): number {
    let count = 0;
    for (const pending of this.outbound(sessionId)) {
      if (this.settle(pending.requestId, { kind: "cancelled", reason })) count++;
    }
    return count;
  }

  /**
   * Give up on every ask addressed to a session that is not coming back, and
   * release the askers. Distinct from `cancelSession`: the askers are alive and
   * well, and what they need to hear is that their answer is never arriving.
   */
  abandonTarget(sessionId: SessionId, reason: string): number {
    let count = 0;
    for (const pending of this.inbound(sessionId)) {
      const settled = this.settle(pending.requestId, {
        kind: "unanswered",
        reason,
        nudges: pending.nudges,
      });
      if (settled) count++;
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
