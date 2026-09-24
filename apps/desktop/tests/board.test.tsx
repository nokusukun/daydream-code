/**
 * The board's redesign, pinned at the two places it can silently rot.
 *
 * `moveTo` is the single source of truth for the four legal drags: the lane
 * hints read it to decide what to promise and the drop handler reads it to
 * decide what to send. A change that teaches one and not the other shows up
 * here rather than as a lane that lights up and does nothing.
 *
 * The second half is honesty about not knowing. `enabled` is null until the
 * first answer, and an empty lane that says "nothing is stuck" before the
 * board has been read is the same defect the status bar shipped twice.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { titleFromTask, type SessionRecord } from "@daydream-code/shared";
import type { BoardCard, BoardColumn } from "../src/api.js";
import { moveTo, moveVerb, openTargetOf, taskSubtext, type Move } from "../src/views/BoardView.js";

vi.mock("../src/harness.js", () => ({
  useHarness: () => ({ api: {}, select: vi.fn(), newSession: vi.fn() }),
}));
vi.mock("../src/sessions.js", () => ({ useSessions: () => ({ sessions: state.sessions }) }));

const state: { enabled: boolean | null; cards: BoardCard[]; sessions: SessionRecord[] } = {
  enabled: true,
  cards: [],
  sessions: [],
};

function session(id: string, name: string): SessionRecord {
  return { id, name, status: "running" } as unknown as SessionRecord;
}

vi.mock("../src/board.js", async () => {
  const actual = await vi.importActual<typeof import("../src/board.js")>("../src/board.js");
  return {
    ...actual,
    useBoard: () => ({ enabled: state.enabled, cards: state.cards, error: null, refresh: vi.fn() }),
  };
});

function card(column: BoardColumn, over: Partial<BoardCard> = {}): BoardCard {
  return {
    id: `card_${column}`,
    projectId: "proj" as BoardCard["projectId"],
    column,
    position: 1,
    title: `a ${column} card`,
    task: `do the ${column} thing`,
    request: {},
    sessionId: null,
    evaluatorSessionId: null,
    blockedBy: [],
    attentionReason: null,
    verdict: null,
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
    ...over,
  };
}

async function render(
  cards: BoardCard[],
  enabled: boolean | null = true,
  sessions: SessionRecord[] = [],
): Promise<string> {
  state.cards = cards;
  state.enabled = enabled;
  state.sessions = sessions;
  const { BoardView } = await import("../src/views/BoardView.js");
  return renderToStaticMarkup(createElement(BoardView));
}

describe("what a drag would do", () => {
  it("names the four legal moves and nothing else", () => {
    expect(moveTo(card("draft"), "queued")).toBe("queue");
    expect(moveTo(card("queued"), "queued")).toBe("reorder");
    expect(moveTo(card("blocked"), "queued")).toBe("reorder");
    expect(moveTo(card("queued"), "working")).toBe("start");
    expect(moveTo(card("blocked"), "working")).toBe("start");
    expect(moveTo(card("evaluating"), "working")).toBe("start");
    expect(moveTo(card("queued"), "bin")).toBe("cancel");
    expect(moveTo(card("draft"), "bin")).toBe("cancel");
    expect(moveTo(card("working", { sessionId: "s1" as BoardCard["sessionId"] }), "queued")).toBe(
      "block",
    );
  });

  it("refuses the drops the server would refuse", () => {
    // Every other pair is inert. A lane that lit up for these was inviting a
    // drop it would swallow.
    expect(moveTo(card("draft"), "working")).toBeNull();
    expect(moveTo(card("done"), "queued")).toBeNull();
    expect(moveTo(card("done"), "bin")).toBeNull();
    expect(moveTo(card("attention"), "working")).toBeNull();
    expect(moveTo(card("working"), "bin")).toBeNull();
    expect(moveTo(card("working"), "working")).toBeNull();
    expect(moveTo(card("evaluating"), "bin")).toBeNull();
    // A Working card with no session cannot block anything: the blocker is
    // named by session, and there is no name to send.
    expect(moveTo(card("working"), "queued")).toBeNull();
    for (const lane of ["draft", "evaluating", "attention", "done"]) {
      for (const column of ["draft", "queued", "blocked", "working", "done"] as BoardColumn[]) {
        expect(moveTo(card(column), lane)).toBeNull();
      }
    }
  });

  it("gives every move a distinct verb to show in the lane head", () => {
    const moves: Move[] = ["start", "queue", "reorder", "block", "cancel"];
    const verbs = moves.map(moveVerb);
    expect(new Set(verbs).size).toBe(moves.length);
    for (const verb of verbs) expect(verb.length).toBeGreaterThan(3);
  });
});

describe("a board that has not answered yet", () => {
  it("holds skeletons and claims nothing about its lanes", async () => {
    const html = await render([], null);
    expect(html).toContain("board-card-skel");
    expect(html).toContain("checking");
    // The teaching lines are claims about an empty lane. Before the first
    // answer the lanes are not empty, they are unread.
    expect(html).not.toContain("nothing is stuck");
    expect(html).not.toContain("cards wait here in order");
    expect(html).not.toContain("finished cards stay");
    // Nor a count, which would read as a hard zero.
    expect(html).not.toContain("board-lane-count");
  });

  it("teaches each lane once it knows the lane is empty", async () => {
    const html = await render([], true);
    expect(html).not.toContain("board-card-skel");
    expect(html).toContain("nothing is stuck");
    expect(html).toContain("cards wait here in order");
    expect(html).toContain("board-lane-count");
  });
});

describe("the header", () => {
  it("says who needs a person, and agrees with itself about number", async () => {
    expect(await render([card("attention", { attentionReason: "the run failed" })])).toContain(
      "1 card needs you",
    );
    const two = await render([
      card("attention", { id: "a" }),
      card("attention", { id: "b" }),
    ]);
    expect(two).toContain("2 cards need you");
  });

  it("stays quiet when nothing is waiting on a person", async () => {
    const html = await render([card("queued")]);
    expect(html).not.toContain("board-alert");
  });
});

describe("a card", () => {
  it("keeps its actions in the document so the keyboard can reach them", async () => {
    // They fade in on hover and focus-within rather than being mounted on
    // hover: a control that only exists under a pointer is a mouse-only
    // affordance, which PRODUCT.md rules out.
    const html = await render([card("queued")]);
    expect(html).toContain("Start now");
    expect(html).toContain("Cancel");
    expect(html).toContain("board-card-actions");
  });

  it("is only picked up from a lane a person may move it out of", async () => {
    expect(await render([card("queued")])).toContain('draggable="true"');
    expect(await render([card("done")])).toContain('draggable="false"');
    expect(await render([card("attention")])).toContain('draggable="false"');
  });

  it("opens exactly the thread its facts row offers, and only that", () => {
    // The whole-card click mirrors the primary link: work session first,
    // evaluator only while evaluating. A card with neither has no thread
    // and must stay inert rather than growing a dead click.
    const work = { id: "s1" };
    const evl = { id: "e1" };
    expect(openTargetOf(card("working"), work, undefined)).toBe("s1");
    expect(openTargetOf(card("attention"), work, evl)).toBe("s1");
    expect(openTargetOf(card("evaluating"), undefined, evl)).toBe("e1");
    // An evaluating card that already has a work session opens the work.
    expect(openTargetOf(card("evaluating"), work, evl)).toBe("s1");
    // An evaluator left on a settled card is history, not a click target.
    expect(openTargetOf(card("done"), undefined, evl)).toBeNull();
    expect(openTargetOf(card("draft"), undefined, undefined)).toBeNull();
    expect(openTargetOf(card("queued"), undefined, undefined)).toBeNull();
  });

  it("wears the click affordance only when it has a thread to open", async () => {
    const openable = await render(
      [card("working", { sessionId: "s1" as BoardCard["sessionId"] })],
      true,
      [session("s1", "sess-one")],
    );
    expect(openable).toContain("is-openable");

    // Same column, but the session is not in the rail yet: the facts row
    // shows no link, so the card must not promise a click either.
    expect(await render([card("working", { sessionId: "s1" as BoardCard["sessionId"] })])).not.toContain(
      "is-openable",
    );
    expect(await render([card("queued")])).not.toContain("is-openable");

    const evaluating = await render(
      [card("evaluating", { evaluatorSessionId: "e1" as BoardCard["evaluatorSessionId"] })],
      true,
      [session("e1", "eval-one")],
    );
    expect(evaluating).toContain("is-openable");
  });

  it("offers one tab stop per lane rather than one per card", async () => {
    const html = await render([
      card("queued", { id: "q1" }),
      card("queued", { id: "q2" }),
      card("queued", { id: "q3" }),
    ]);
    expect([...html.matchAll(/tabindex="0"/g)]).toHaveLength(1);
    expect([...html.matchAll(/tabindex="-1"/g)]).toHaveLength(2);
  });
});

describe("the subtext", () => {
  // The title is `titleFromTask(task)` — the task's first sentence — so the
  // task line must never repeat what the title just said. Two lines at
  // most; the description, not the prose.
  it("vanishes when the title already says the whole task", async () => {
    const task = "Clicking on a board item should open the thread.";
    const html = await render([card("queued", { title: titleFromTask(task), task })]);
    expect(html).not.toContain("board-card-task");
    // Positive control for the negative above: the same task under a title
    // that does not cover it must render the line — proving the class name
    // is still real, so the absence means deduped, not renamed.
    const control = await render([card("queued", { title: "renamed by a session", task })]);
    expect(control).toContain("board-card-task");
  });

  it("says only what the task adds beyond the title", () => {
    const task = "Redesign the board. Keep the new-card door and the drag hints working.";
    expect(taskSubtext(titleFromTask(task), task)).toBe(
      "Keep the new-card door and the drag hints working.",
    );
  });

  it("drops the whole first sentence even when the title truncated it", () => {
    // A 72-char cap ends the title with an ellipsis mid-sentence. The
    // subtext must not open with the severed tail of that sentence.
    const long =
      "When creating a new kanban item, it should open to a new thread so we get to reuse everything.";
    const task = `${long} Also wire the composer.`;
    expect(taskSubtext(titleFromTask(task), task)).toBe("Also wire the composer.");
  });

  it("keeps the whole task once a session has renamed the card", () => {
    const task = "Do the queued thing. Then the other thing.";
    expect(taskSubtext("a friendlier session title", task)).toBe(task);
  });

  it("collapses a multi-line task into one description", () => {
    const task = "Fix the board.\n\nThe lanes squeeze their cards.\nAlso the counts are wrong.";
    expect(taskSubtext(titleFromTask(task), task)).toBe(
      "The lanes squeeze their cards. Also the counts are wrong.",
    );
  });

  it("keeps the clamped text recoverable in tooltips", async () => {
    const task = "Redesign the board. Keep the new-card door and the drag hints working.";
    const html = await render([
      card("queued", {
        title: titleFromTask(task),
        task,
        verdict: {
          decision: "proceed",
          reason: "no overlap with the working session",
          at: "2026-09-24T00:00:00.000Z",
        },
      }),
    ]);
    // The task line carries the full task; the reason line carries the full
    // verdict prose — the clamp hides text, it must not lose it.
    expect(html).toContain(`title="${task}"`);
    expect(html).toContain("evaluator: proceed — no overlap with the working session");
  });
});

describe("the stylesheet", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const board = css.slice(css.indexOf("   Board mode."));

  it("carries no side-stripe accents, and carries what replaced them", () => {
    // DESIGN.md's do-not-add list, and the skill's. Blocked, Working and
    // Needs Attention each wore a 3px left rule; they now wear a full border
    // and a wash. Asserting the replacement too, so this cannot pass by the
    // rules simply having been deleted.
    expect(board).not.toMatch(/border-left:\s*[2-9]px/);
    for (const [cls, token] of [
      ["board-card-blocked", "--warn"],
      ["board-card-working", "--accent"],
      ["board-card-attention", "--bad"],
    ]) {
      const rule = board.slice(board.indexOf(`.${cls} {`), board.indexOf(`.${cls} {`) + 240);
      expect(rule).toContain("border-color");
      expect(rule).toContain(`background: color-mix(in oklab, var(${token})`);
    }
  });

  it("clamps every prose line on the card to two lines, the verdict reason included", () => {
    // Two lines at most, everywhere. The reason is the evaluator's verdict
    // prose — the one line with no natural bound, and the one the card
    // used to let run to a paragraph; the task is deduped against the
    // title before it renders, so two lines is all it ever needs.
    for (const [cls, lines] of [
      ["board-card-title", 2],
      ["board-card-task", 2],
      ["board-card-reason", 2],
    ] as const) {
      // Line-anchored: `.board-card-done .board-card-title {` also contains
      // the bare selector, and indexOf would land on it first.
      const at = board.indexOf(`\n.${cls} {`);
      expect(at, cls).toBeGreaterThan(-1);
      expect(board.slice(at, board.indexOf("}", at)), cls).toContain(
        `-webkit-line-clamp: ${lines}`,
      );
    }
  });

  it("promises the click with a pointer on openable cards", () => {
    // The base card cursor is grab; a card that opens a thread must win
    // that tie or the click affordance is invisible.
    expect(board).toMatch(/\.board-card\.is-openable \{\s*cursor: pointer;/);
  });

  it("stops the lane scroller from squeezing its cards", () => {
    // `.transcript > *` and `.runs > *` learned this the hard way: a flex
    // column that scrolls shrinks its children into hairlines.
    expect(board).toMatch(/\.board-lane-cards > \* \{\s*flex: none;/);
  });
});
