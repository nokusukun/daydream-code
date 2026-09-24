/**
 * Making a card goes through the thread composer.
 *
 * The board used to carry a second composer of its own — a textarea in the
 * Drafts lane that could name a task and nothing else, so the cards it made
 * could not say which driver, model, effort or attachments the work wanted.
 * These pin the replacement: the lane offers a way *into* the thread
 * composer, and that composer keeps both card destinations.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { BoardCard } from "../src/api.js";
import { taskDestination } from "../src/views/Composer.js";

const newSession = vi.fn();

vi.mock("../src/harness.js", () => ({
  useHarness: () => ({ api: {}, select: vi.fn(), newSession }),
}));
vi.mock("../src/sessions.js", () => ({ useSessions: () => ({ sessions: [] }) }));

const cards: BoardCard[] = [];
vi.mock("../src/board.js", async () => {
  const actual = await vi.importActual<typeof import("../src/board.js")>(
    "../src/board.js",
  );
  return {
    ...actual,
    useBoard: () => ({ enabled: true, cards, error: null, refresh: vi.fn() }),
  };
});

describe("where a described task goes", () => {
  it("queues a card in kanban mode and dispatches a run otherwise", () => {
    expect(taskDestination(true, false)).toBe("card");
    expect(taskDestination(false, false)).toBe("dispatch");
    // Null is "not answered yet", and the honest fallback is the plain run:
    // a project that is not in kanban mode has no board to queue onto.
    expect(taskDestination(null, false)).toBe("dispatch");
  });

  it("shelves a card in Drafts when the second action is pressed", () => {
    expect(taskDestination(true, true)).toBe("draft-card");
  });
});

describe("the board's Drafts lane", () => {
  it("opens a new thread instead of holding a composer of its own", async () => {
    const { BoardView } = await import("../src/views/BoardView.js");
    const html = renderToStaticMarkup(createElement(BoardView));
    expect(html).toContain("board-lane-new");
    expect(html).toContain("+ New card");
    // The lane-local textarea is the thing being replaced; it coming back
    // means two ways to make a card again, one of them impoverished.
    expect(html).not.toContain("board-draft-composer");
    expect(html).not.toContain("Jot a task to queue later");
  });
});
