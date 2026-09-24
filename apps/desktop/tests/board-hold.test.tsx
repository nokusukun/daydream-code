/**
 * A follow-up sent to a finished kanban thread is re-queued on the board, and
 * the thread has to say so: the session stays `completed` and the transcript
 * draws nothing for the board's deferred row, so without the notice the
 * message looks lost and the thread looks idle.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BoardCard, BoardColumn } from "../src/api.js";
import { boardHold, holdHeadline } from "../src/board-hold.js";
import { BoardHoldNotice } from "../src/views/Composer.js";

function card(column: BoardColumn, over: Partial<BoardCard> = {}): BoardCard {
  return {
    id: "card_1",
    projectId: "p_1" as BoardCard["projectId"],
    column,
    position: 1,
    title: "Board looks cramped",
    task: "I can't scroll to the right",
    request: {},
    sessionId: "ses_work" as BoardCard["sessionId"],
    evaluatorSessionId: null,
    blockedBy: [],
    attentionReason: null,
    verdict: null,
    planId: null,
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
    ...over,
  };
}

function render(hold: NonNullable<ReturnType<typeof boardHold>>): string {
  return renderToStaticMarkup(
    createElement(BoardHoldNotice, { hold, starting: false, onWatch() {}, onStart() {} }),
  );
}

describe("boardHold", () => {
  it("holds a thread whose card is waiting on the board", () => {
    expect(boardHold([card("queued")], "ses_work")?.kind).toBe("queued");
    const evaluating = boardHold(
      [card("evaluating", { evaluatorSessionId: "ses_eval" as BoardCard["sessionId"] })],
      "ses_work",
    );
    expect(evaluating).toEqual({
      kind: "evaluating",
      cardId: "card_1",
      message: "I can't scroll to the right",
      evaluatorId: "ses_eval",
    });
  });

  it("names the blockers and carries the verdict's reason", () => {
    const hold = boardHold(
      [
        card("blocked", {
          blockedBy: [
            {
              blockerSessionId: "ses_a" as BoardCard["sessionId"] & string,
              blockerName: "redesign-board",
              source: "evaluator",
              reason: "same lane markup",
              createdAt: "2026-09-24T00:00:00.000Z",
            },
          ] as BoardCard["blockedBy"],
        }),
      ],
      "ses_work",
    );
    expect(hold).toMatchObject({ kind: "blocked", blockers: ["redesign-board"], reason: "same lane markup" });
    expect(holdHeadline(hold!)).toBe("Waiting on redesign-board");
  });

  it("does not hold a thread the board is running, finished with, or does not own", () => {
    for (const column of ["working", "attention", "done", "draft"] as const) {
      expect(boardHold([card(column)], "ses_work")).toBeNull();
    }
    expect(boardHold([card("evaluating")], "ses_other")).toBeNull();
    // An evaluator's own thread is not held by the card it evaluates.
    expect(
      boardHold(
        [card("evaluating", { evaluatorSessionId: "ses_eval" as BoardCard["sessionId"] })],
        "ses_eval",
      ),
    ).toBeNull();
  });
});

describe("BoardHoldNotice", () => {
  it("says it is evaluating, quotes the held message, and offers the evaluator", () => {
    const html = render({
      kind: "evaluating",
      cardId: "card_1",
      message: "I can't scroll to the right",
      evaluatorId: "ses_eval",
    });
    expect(html).toContain("Evaluating before this runs");
    expect(html).toContain("I can&#x27;t scroll to the right");
    expect(html).toContain("glyph-evaluating");
    expect(html).toContain(">Watch<");
    expect(html).toContain(">Start now<");
  });

  it("offers no Watch before an evaluator exists", () => {
    const html = render({ kind: "queued", cardId: "card_1", message: "hi" });
    expect(html).toContain("Queued on the board");
    // Positive control above proves the label is real; its absence here means
    // there is no evaluator to open, not that the button was renamed.
    expect(html).not.toContain(">Watch<");
    expect(html).not.toContain("glyph-evaluating");
  });
});
