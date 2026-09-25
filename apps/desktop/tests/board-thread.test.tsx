/**
 * Opening a card keeps the board on screen: the thread it points at sits in a
 * pane beside the lanes, and the card says it is the open one.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "@daydream-code/shared";
import type { BoardCard, BoardColumn } from "../src/api.js";

const state: { cards: BoardCard[]; sessions: SessionRecord[] } = { cards: [], sessions: [] };

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
    display: { unread: "off", peekMarksRead: true },
    error: null,
    refresh: vi.fn(),
  }),
}));
// The transcript has its own tests. Here it only has to say which thread it is.
vi.mock("../src/views/SessionPanel.js", () => ({
  SessionPanel: (props: { id: string; expand?: { label: string } }) =>
    createElement("div", { "data-thread": props.id, "data-expand": props.expand?.label }),
}));

function session(id: string): SessionRecord {
  return { id, name: `thread-${id}`, status: "running", archivedAt: null } as unknown as SessionRecord;
}

function card(id: string, column: BoardColumn, sessionId: string | null): BoardCard {
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
    seenAt: null,
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
  };
}

const stored = new Map<string, string>();

beforeEach(() => {
  stored.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function render(open: string | null): Promise<string> {
  if (open !== null) stored.set("daydream.board.thread", open);
  state.sessions = [session("s1"), session("s2")];
  state.cards = [card("c1", "working", "s1"), card("c2", "working", "s2")];
  const { BoardView } = await import("../src/views/BoardView.js");
  return renderToStaticMarkup(createElement(BoardView));
}

/** One card's opening tag. */
function cardTag(html: string, id: string): string {
  const at = html.indexOf(`data-card="${id}"`);
  expect(at).toBeGreaterThan(-1);
  const start = html.lastIndexOf("<article", at);
  return html.slice(start, html.indexOf(">", at) + 1);
}

describe("the thread beside the board", () => {
  it("is just the board when no card is open", async () => {
    const html = await render(null);
    expect(html).toContain("board-lanes");
    expect(html).not.toContain("split-handle");
    expect(html).not.toContain("data-thread=");
    expect(cardTag(html, "c1")).not.toMatch(/\bis-open[ "]/);
  });

  it("shows the open card's thread next to the lanes and marks that card", async () => {
    const html = await render("s2");
    expect(html).toContain("board-lanes");
    expect(html).toContain('aria-label="Resize card thread"');
    expect(html).toContain('data-thread="s2"');
    expect(html.indexOf("board-lanes")).toBeLessThan(html.indexOf('data-thread="s2"'));
    expect(cardTag(html, "c2")).toMatch(/\bis-open[ "]/);
    expect(cardTag(html, "c2")).toContain('aria-current="true"');
    expect(cardTag(html, "c1")).not.toMatch(/\bis-open[ "]/);
  });

  it("offers to open the thread in Threads mode", async () => {
    const html = await render("s2");
    expect(html).toContain('data-expand="Open in Threads"');
  });

  it("does not open a remembered thread this project does not have", async () => {
    const html = await render("gone");
    expect(html).not.toContain("split-handle");
    expect(html).not.toContain("data-thread=");
  });
});

describe("the panel header", () => {
  it("draws the expand button only when a panel asks for one", async () => {
    const { PanelHead } = await import("../src/views/PanelHead.js");
    const expand = { label: "Open in Threads", onClick: () => undefined };
    const withIt = renderToStaticMarkup(createElement(PanelHead, { title: "t", expand }));
    const without = renderToStaticMarkup(createElement(PanelHead, { title: "t" }));
    expect(withIt).toContain('aria-label="Open in Threads"');
    expect(without).not.toContain("panel-expand");
  });
});
