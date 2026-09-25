/**
 * Unread Done cards: which ones a shown thread marks read, and how the board
 * draws the rest under each setting.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "@daydream-code/shared";
import type { BoardCard, BoardColumn, BoardDisplay } from "../src/api.js";
import { readNow } from "../src/board-read.js";

const state: { cards: BoardCard[]; sessions: SessionRecord[]; display: BoardDisplay } = {
  cards: [],
  sessions: [],
  display: { unread: "highlight", peekMarksRead: true },
};

vi.mock("../src/harness.js", () => ({
  useHarness: () => ({ api: {}, select: vi.fn(), newSession: vi.fn() }),
}));
vi.mock("../src/sessions.js", async () => ({
  ...(await vi.importActual<typeof import("../src/sessions.js")>("../src/sessions.js")),
  useSessions: () => ({ sessions: state.sessions }),
}));
vi.mock("../src/board.js", async () => ({
  ...(await vi.importActual<typeof import("../src/board.js")>("../src/board.js")),
  useBoard: () => ({
    enabled: true,
    cards: state.cards,
    display: state.display,
    error: null,
    refresh: vi.fn(),
  }),
}));

function session(id: string, archivedAt: string | null = null): SessionRecord {
  return { id, name: `thread-${id}`, status: "completed", archivedAt } as unknown as SessionRecord;
}

function card(id: string, column: BoardColumn, sessionId: string | null, seenAt: string | null): BoardCard {
  return {
    id,
    projectId: "proj" as BoardCard["projectId"],
    column,
    position: 1,
    title: `card ${id}`,
    task: `card ${id}`,
    request: {},
    sessionId: sessionId as BoardCard["sessionId"],
    evaluatorSessionId: null,
    blockedBy: [],
    attentionReason: null,
    verdict: null,
    planId: null,
    seenAt,
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
  };
}

async function doneLane(cards: BoardCard[], sessions: SessionRecord[], display: BoardDisplay): Promise<string> {
  state.cards = cards;
  state.sessions = sessions;
  state.display = display;
  const { BoardView } = await import("../src/views/BoardView.js");
  const html = renderToStaticMarkup(createElement(BoardView));
  const start = html.indexOf("board-lane board-lane-done");
  expect(start).toBeGreaterThan(-1);
  return html.slice(start);
}

/** One card's opening tag and everything up to the next card. */
function cardHtml(html: string, id: string): string {
  const at = html.indexOf(`data-card="${id}"`);
  expect(at).toBeGreaterThan(-1);
  const next = html.indexOf("data-card=", at + 1);
  return html.slice(html.lastIndexOf("<article", at), next === -1 ? undefined : next);
}

describe("readNow", () => {
  const cards = [
    card("fresh", "done", "a", null),
    card("read", "done", "b", "2026-09-24T01:00:00.000Z"),
    card("running", "working", "c", null),
  ];
  const on = { peekMarksRead: true, focused: true };

  it("marks an unread Done card whose thread is open", () => {
    expect(readNow(cards, [{ sessionId: "a", kind: "open" }], on)).toEqual(["fresh"]);
  });

  it("leaves read cards, cards still running, and threads nobody opened", () => {
    const shown = [
      { sessionId: "b", kind: "open" as const },
      { sessionId: "c", kind: "open" as const },
    ];
    expect(readNow(cards, shown, on)).toEqual([]);
  });

  it("counts a peek only when the setting says it does", () => {
    const peek = [{ sessionId: "a", kind: "peek" as const }];
    expect(readNow(cards, peek, on)).toEqual(["fresh"]);
    expect(readNow(cards, peek, { ...on, peekMarksRead: false })).toEqual([]);
  });

  it("reads nothing in a window the person is not looking at", () => {
    expect(readNow(cards, [{ sessionId: "a", kind: "open" }], { ...on, focused: false })).toEqual([]);
  });
});

describe("the Done lane", () => {
  const cards = [
    card("fresh", "done", "a", null),
    card("also", "done", "b", null),
    card("read", "done", "c", "2026-09-24T01:00:00.000Z"),
  ];
  const sessions = [session("a"), session("b"), session("c")];

  it("highlights unread cards with a dot, and offers to mark them all read", async () => {
    const html = await doneLane(cards, sessions, { unread: "highlight", peekMarksRead: true });
    expect(cardHtml(html, "fresh")).toContain("is-unread is-unread-highlight");
    expect(cardHtml(html, "fresh")).toContain('class="board-card-unread"');
    expect(cardHtml(html, "read")).not.toContain("is-unread");
    expect(cardHtml(html, "read")).not.toContain("board-card-unread");
    const head = html.slice(0, html.indexOf("</h2>"));
    expect(head).toContain('aria-label="Mark 2 unread cards as read"');
    expect(head).toContain(">2 unread</button>");
  });

  it("dot keeps the card as quiet as any finished card and still marks it", async () => {
    const html = await doneLane(cards, sessions, { unread: "dot", peekMarksRead: true });
    expect(cardHtml(html, "fresh")).toContain("is-unread is-unread-dot");
    expect(cardHtml(html, "fresh")).not.toContain("is-unread-highlight");
    expect(cardHtml(html, "fresh")).toContain('class="board-card-unread"');
  });

  it("off draws no mark and no count", async () => {
    const html = await doneLane(cards, sessions, { unread: "off", peekMarksRead: true });
    expect(html).not.toContain("is-unread");
    expect(html).not.toContain("board-card-unread");
    expect(html).not.toContain("board-lane-unread");
  });

  it("an archived card is dealt with, read or not", async () => {
    const html = await doneLane(
      [card("shelved", "done", "a", null)],
      [session("a", "2026-09-24T02:00:00.000Z")],
      { unread: "highlight", peekMarksRead: true },
    );
    expect(html).not.toContain("board-lane-unread");
  });
});
