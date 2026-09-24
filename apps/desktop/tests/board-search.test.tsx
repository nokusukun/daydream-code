/**
 * Searching the board.
 *
 * The field's typing and ⌘F need a DOM this suite does not have, so the
 * rules live in two pure functions and are tested there: what a card
 * matches on, and which cards a lane shows once a search is on.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "@daydream-code/shared";
import type { BoardCard, BoardColumn } from "../src/api.js";
import { cardMatches, laneShows } from "../src/views/BoardView.js";

const state: { cards: BoardCard[] } = { cards: [] };

vi.mock("../src/harness.js", () => ({
  useHarness: () => ({ api: {}, select: vi.fn(), newSession: vi.fn() }),
}));
vi.mock("../src/sessions.js", async () => ({
  ...(await vi.importActual<typeof import("../src/sessions.js")>("../src/sessions.js")),
  useSessions: () => ({ sessions: [] }),
}));
vi.mock("../src/board.js", async () => ({
  ...(await vi.importActual<typeof import("../src/board.js")>("../src/board.js")),
  useBoard: () => ({ enabled: true, cards: state.cards, error: null, refresh: vi.fn() }),
}));

function card(id: string, patch: Partial<BoardCard> = {}, column: BoardColumn = "done"): BoardCard {
  return {
    id,
    projectId: "proj" as BoardCard["projectId"],
    column,
    position: 1,
    title: `card ${id}`,
    task: `card ${id}`,
    request: {},
    sessionId: null,
    evaluatorSessionId: null,
    blockedBy: [],
    attentionReason: null,
    verdict: null,
    planId: null,
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
    ...patch,
  };
}

const named = (name: string) => ({ name }) as Pick<SessionRecord, "name">;

describe("cardMatches", () => {
  it("matches everything on an empty or blank query", () => {
    expect(cardMatches(card("a"), undefined, "")).toBe(true);
    expect(cardMatches(card("a"), undefined, "   ")).toBe(true);
  });

  it("is case-insensitive and needs every term, in any order", () => {
    const c = card("a", { title: "The hide thread button is broken on hover" });
    expect(cardMatches(c, undefined, "HOVER hide")).toBe(true);
    expect(cardMatches(c, undefined, "hover archive")).toBe(false);
  });

  it("finds a card by its task beyond the title", () => {
    const c = card("a", { title: "Archive button", task: "Archive button. Use an icon, not text." });
    expect(cardMatches(c, undefined, "icon")).toBe(true);
  });

  it("finds a card by its thread's name", () => {
    const c = card("a", { title: "Make Done wider" });
    expect(cardMatches(c, named("why-kanban-section-widths"), "section-widths")).toBe(true);
    expect(cardMatches(c, undefined, "section-widths")).toBe(false);
  });

  it("finds a card by the verdict, the attention reason and the sessions blocking it", () => {
    const blocked = card(
      "a",
      {
        blockedBy: [
          {
            blockerSessionId: "s1" as BoardCard["blockedBy"][number]["blockerSessionId"],
            blockerName: "use-impeccable-skill-redesign",
            source: "evaluator",
            reason: null,
            createdAt: "2026-09-24T00:00:00.000Z",
          },
        ],
      },
      "queued",
    );
    expect(cardMatches(blocked, undefined, "impeccable")).toBe(true);
    const failed = card("b", { attentionReason: "sqlite ABI mismatch" }, "attention");
    expect(cardMatches(failed, undefined, "abi")).toBe(true);
    const cleared = card("c", {
      verdict: { decision: "proceed", reason: "no overlap with BoardView.tsx" } as BoardCard["verdict"],
    });
    expect(cardMatches(cleared, undefined, "boardview")).toBe(true);
  });
});

describe("laneShows", () => {
  const live = [card("live-hit", { title: "sidebar hover" }), card("live-miss", { title: "model catalog" })];
  const shelved = [card("old-hit", { title: "sidebar toggle" }), card("old-miss", { title: "keep awake" })];
  const ids = (cards: BoardCard[]) => cards.map((c) => c.id);

  it("shows only live cards with the shelf closed and no search", () => {
    expect(ids(laneShows(live, shelved, false, null))).toEqual(["live-hit", "live-miss"]);
  });

  it("appends the archive below the live cards when the shelf is open", () => {
    expect(ids(laneShows(live, shelved, true, null))).toEqual(["live-hit", "live-miss", "old-hit", "old-miss"]);
  });

  it("searches the archive too, with the shelf closed, live hits first", () => {
    const match = (c: BoardCard) => cardMatches(c, undefined, "sidebar");
    expect(ids(laneShows(live, shelved, false, match))).toEqual(["live-hit", "old-hit"]);
    expect(ids(laneShows(live, shelved, true, match))).toEqual(["live-hit", "old-hit"]);
  });
});

describe("the search field", () => {
  it("sits in the board header, labelled, with no count or clear button until there is a query", async () => {
    state.cards = [card("a")];
    const { BoardView } = await import("../src/views/BoardView.js");
    const html = renderToStaticMarkup(createElement(BoardView));
    const head = html.slice(html.indexOf('class="board-head"'), html.indexOf("</header>"));
    expect(head).toContain('class="board-search"');
    expect(head).toContain('aria-label="Search cards"');
    // Positive control for the two absences below: the classes are real
    // names in this file, so not finding them means not rendered.
    const source = (await import("node:fs")).readFileSync(
      new URL("../src/views/BoardView.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain("board-search-count");
    expect(source).toContain("board-search-clear");
    expect(head).not.toContain("board-search-count");
    expect(head).not.toContain("board-search-clear");
    // No search means no lane is marked unmatched.
    expect(html).not.toContain("is-unmatched");
  });
});
