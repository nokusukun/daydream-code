import type { Context } from "@daydream-code/kernel";
import { ThreadId, type SessionId, type SessionRecord } from "@daydream-code/shared";
import type {} from "@daydream-code/thread";
import type {} from "@daydream-code/session";
import type { BoardCard, BoardColumn } from "./index.js";

/**
 * What a move says on the master thread, or null for moves that are noise
 * there. Drafts and the hop into Evaluating are the board's own business;
 * every other move changes what a sibling should expect to happen next.
 */
function lineFor(ctx: Context, card: BoardCard, from: BoardColumn | null): string | null {
  const title = JSON.stringify(card.title);
  switch (card.column) {
    case "draft":
    case "evaluating":
      return null;
    case "queued":
      if (from === "done") return `card ${title} re-queued with a follow-up`;
      if (from === "blocked") return `card ${title} released (${card.attentionReason ?? "blocker finished"}); re-evaluating`;
      if (from === "queued") return null; // a reorder or a defer
      return `card ${title} queued on the board`;
    case "blocked":
      return `card ${title} blocked by ${card.blockedBy.map((b) => `session ${b.blockerName}`).join(", ")}${
        card.verdict?.decision === "block" ? `: ${card.verdict.reason}` : ""
      }`;
    case "working": {
      const name = card.sessionId === null ? null : ctx.sessions.get(card.sessionId)?.name;
      return from === "attention"
        ? `card ${title} back to work`
        : `card ${title} started as session ${name ?? card.sessionId ?? "?"}`;
    }
    case "attention":
      return `card ${title} needs attention: ${card.attentionReason ?? "see the board"}`;
    case "done":
      return `card ${title} done`;
  }
}

/**
 * Consumer plugin: the board's moves become master-thread notes, so every
 * fork sees what is queued and what is waiting on whom, and a blocker is
 * told — once — which cards are waiting for it to finish.
 *
 * The injection is a courtesy, not a nag: a session that knows a card waits
 * on it can wrap up cleanly and say what it left. It is sent once per
 * (card, blocker) pair; repeating it every turn would be the same message
 * `master-inject` already carries in prose.
 */
const boardWriteback = {
  name: "board-writeback",
  inject: ["board", "threads", "sessions"] as const,
  apply(ctx: Context) {
    const master = () => ThreadId(ctx.threads.ensureMaster().id);
    // A card's move is news to everyone except the two sessions it is about:
    // its own run, which is the thing that moved, and its evaluator, whose
    // verdict usually moved it. Told anyway, each wakes to report that its own
    // card changed column — the shape that once started a session with a turn
    // spent reading about its own dispatch.
    const note = (card: BoardCard, content: string): void => {
      // The planner that wrote the card is told nothing either: it queued the
      // plan, or watched the person do it from its own thread, and a note per
      // card would wake it once for each card.
      const planner = card.planId === null ? null : (ctx.board.getPlan(card.planId)?.sessionId ?? null);
      const causedBy = [card.sessionId, card.evaluatorSessionId, planner].filter(
        (id): id is SessionId => id !== null,
      );
      ctx.threads.append({
        threadId: master(),
        kind: "note",
        causedBy,
        message: { role: "user", content },
      });
    };

    ctx.on("board/moved", (card: BoardCard, from: BoardColumn | null) => {
      const line = lineFor(ctx, card, from);
      if (line !== null) note(card, line);
    });
    ctx.on("board/removed", (card: BoardCard) => {
      if (card.column !== "draft") note(card, `card ${JSON.stringify(card.title)} cancelled`);
    });

    const told = new Set<string>();
    // Unlike master-thread news, this may wake a finished blocker on its own:
    // the waiting cards need its closing summary, and `told` caps it at once
    // per (card, blocker).
    ctx.on("session/collect-injections", (session: SessionRecord, blocks: string[]) => {
      const waiting = ctx.board
        .list()
        .filter(
          (card) =>
            card.column === "blocked" &&
            card.blockedBy.some((b) => b.blockerSessionId === session.id) &&
            !told.has(`${card.id}:${session.id}`),
        );
      if (waiting.length === 0) return;
      for (const card of waiting) told.add(`${card.id}:${session.id}`);
      blocks.push(
        [
          "[board] These queued cards are waiting for you to finish before they can start:",
          ...waiting.map((card) => `- ${JSON.stringify(card.title)}: ${card.blockedBy.find((b) => b.blockerSessionId === session.id)?.reason ?? "depends on your work"}`),
          "No reply is needed. When you wrap up, say in your summary what you left in the tree that they should know about.",
        ].join("\n"),
      );
    });
  },
};

export default boardWriteback;
