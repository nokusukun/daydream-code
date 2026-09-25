/**
 * Queue all: the Drafts lane's one-click send to the queue.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "@daydream-code/shared";
import type { BoardCard, BoardColumn, BoardPlan } from "../src/api.js";
import { queueAllDrafts } from "../src/views/BoardView.js";

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
  useBoard: () => ({
    enabled: true,
    cards: state.cards,
    display: { unread: "highlight", peekMarksRead: true },
    error: null,
    refresh: vi.fn(),
  }),
}));

function card(id: string, column: BoardColumn, position: number, planId: string | null = null): BoardCard {
  return {
    id,
    projectId: "proj" as BoardCard["projectId"],
    column,
    position,
    title: `card ${id}`,
    task: `card ${id}`,
    request: {},
    sessionId: null,
    evaluatorSessionId: null,
    blockedBy: [],
    attentionReason: null,
    verdict: null,
    planId,
    seenAt: null,
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
  };
}

function plan(id: string, sessionId: string | null): BoardPlan {
  return {
    id,
    sessionId: sessionId as BoardPlan["sessionId"],
    title: id,
    request: {},
    createdAt: "2026-09-24T00:00:00.000Z",
  };
}

function session(id: string, status: SessionRecord["status"]): SessionRecord {
  return { id, name: id, status } as unknown as SessionRecord;
}

async function draftsHead(cards: BoardCard[]): Promise<string> {
  state.cards = cards;
  const { BoardView } = await import("../src/views/BoardView.js");
  const html = renderToStaticMarkup(createElement(BoardView));
  const lane = html.slice(html.indexOf("board-lane board-lane-draft"));
  expect(lane.length).toBeLessThan(html.length);
  return lane.slice(0, lane.indexOf("</h2>"));
}

describe("the Drafts lane head", () => {
  it("offers Queue all as a named icon once there is more than one draft", async () => {
    const head = await draftsHead([card("a", "draft", 1), card("b", "draft", 2), card("q", "queued", 3)]);
    expect(head).toMatch(/aria-label="Queue all 2 drafts"[^>]*><svg/);
  });

  it("leaves it out for a single draft, whose own Queue button does the same", async () => {
    const head = await draftsHead([card("a", "draft", 1), card("q", "queued", 2)]);
    expect(head).not.toContain("Queue all");
  });
});

describe("queueAllDrafts", () => {
  const sessions = new Map([
    ["writer", session("writer", "running")],
    ["finished", session("finished", "completed")],
  ]);
  const sessionOf = (id: string) => sessions.get(id);

  it("sends drafts oldest first, so the queue keeps the order they were written in", () => {
    const drafts = [card("new", "draft", 3), card("old", "draft", 1), card("mid", "draft", 2)];
    expect(queueAllDrafts(drafts, [], sessionOf).map((c) => c.id)).toEqual(["old", "mid", "new"]);
  });

  it("holds back drafts whose planner is still writing, and keeps a finished plan's", () => {
    const drafts = [
      card("loose", "draft", 1),
      card("writing", "draft", 2, "p-live"),
      card("dispatching", "draft", 3, "p-new"),
      card("reviewed", "draft", 4, "p-done"),
    ];
    const plans = [plan("p-live", "writer"), plan("p-new", null), plan("p-done", "finished")];
    expect(queueAllDrafts(drafts, plans, sessionOf).map((c) => c.id)).toEqual(["loose", "reviewed"]);
  });
});
