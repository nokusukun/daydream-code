/**
 * What the board is doing with a thread's next turn, as the thread shows it.
 *
 * Under kanban, a message sent to a finished thread does not run: the board's
 * continue intercept re-queues the thread's card with the message as its task
 * and the turn waits for evaluation. Nothing in the transcript says so — the
 * `user_message_deferred` row the board journals carries `{ text, cardId }`,
 * not the runner's next-message shape, so the panel draws nothing for it — and
 * the session itself stays `completed`. Without this the thread looks idle and
 * the message looks lost.
 *
 * Read from the card, not the journal: the card is the thing that moves, and
 * it is already live over the socket.
 */
import type { BoardCard } from "./api.js";

export type BoardHold =
  | { kind: "queued"; cardId: string; message: string }
  | { kind: "evaluating"; cardId: string; message: string; evaluatorId: string | null }
  | { kind: "blocked"; cardId: string; message: string; blockers: string[]; reason: string | null };

/**
 * The hold on `sessionId`'s next turn, or null when the board is not holding
 * it. Only a card that has already been Working has a `sessionId`, so a card
 * in Queued/Evaluating/Blocked that points at this thread is by construction
 * a follow-up waiting its turn.
 */
export function boardHold(cards: readonly BoardCard[], sessionId: string): BoardHold | null {
  const card = cards.find((candidate) => candidate.sessionId === sessionId);
  if (card === undefined) return null;
  const base = { cardId: card.id, message: card.task };
  switch (card.column) {
    case "queued":
      return { kind: "queued", ...base };
    case "evaluating":
      return { kind: "evaluating", ...base, evaluatorId: card.evaluatorSessionId };
    case "blocked":
      return {
        kind: "blocked",
        ...base,
        blockers: card.blockedBy.map((block) => block.blockerName),
        // Every evaluator block carries the same verdict reason; the first one
        // says it. A hand-set block may carry none.
        reason: card.blockedBy.find((block) => block.reason !== null)?.reason ?? null,
      };
    default:
      return null;
  }
}

/** The notice's headline: what is happening, in the words the board uses. */
export function holdHeadline(hold: BoardHold): string {
  switch (hold.kind) {
    case "queued":
      return "Queued on the board";
    case "evaluating":
      return "Evaluating before this runs";
    case "blocked":
      return hold.blockers.length > 0
        ? `Waiting on ${hold.blockers.join(", ")}`
        : "Blocked on the board";
  }
}
