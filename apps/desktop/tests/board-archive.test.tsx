/**
 * Archiving Done cards.
 *
 * A card's archive is its thread's archive, so these tests turn on
 * `archivedAt` of the session behind the card. The board has no flag of its
 * own to test.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "@daydream-code/shared";
import type { BoardCard, BoardColumn } from "../src/api.js";
import { isShelved } from "../src/views/BoardView.js";

const state: { cards: BoardCard[]; sessions: SessionRecord[] } = { cards: [], sessions: [] };

vi.mock("../src/harness.js", () => ({
  useHarness: () => ({ api: {}, select: vi.fn(), newSession: vi.fn() }),
}));
// The real `isArchived` stays in: it is the predicate that learned the hard
// way that a missing `archivedAt` is not an archived one.
vi.mock("../src/sessions.js", async () => ({
  ...(await vi.importActual<typeof import("../src/sessions.js")>("../src/sessions.js")),
  useSessions: () => ({ sessions: state.sessions }),
}));
vi.mock("../src/board.js", async () => ({
  ...(await vi.importActual<typeof import("../src/board.js")>("../src/board.js")),
  useBoard: () => ({ enabled: true, cards: state.cards, error: null, refresh: vi.fn() }),
}));

function session(id: string, archivedAt: string | null | undefined): SessionRecord {
  return { id, name: `thread-${id}`, status: "completed", archivedAt } as unknown as SessionRecord;
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
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
  };
}

async function render(cards: BoardCard[], sessions: SessionRecord[]): Promise<string> {
  state.cards = cards;
  state.sessions = sessions;
  const { BoardView } = await import("../src/views/BoardView.js");
  return renderToStaticMarkup(createElement(BoardView));
}

/** The Done lane's markup alone, so assertions cannot match another lane. */
function doneLane(html: string): string {
  const start = html.indexOf('board-lane board-lane-done');
  expect(start).toBeGreaterThan(-1);
  return html.slice(start);
}

describe("isShelved", () => {
  const archived = session("s1", "2026-09-24T01:00:00.000Z");

  it("is true only for a Done card whose thread is archived", () => {
    expect(isShelved({ column: "done" }, archived)).toBe(true);
    expect(isShelved({ column: "done" }, session("s2", null))).toBe(false);
    expect(isShelved({ column: "done" }, undefined)).toBe(false);
  });

  it("never hides work in flight, whatever the thread's shelf says", () => {
    // A follow-up re-queues a Done card while its thread is still archived
    // (the thread is un-shelved only when it revives), so this case is real.
    for (const column of ["queued", "evaluating", "blocked", "working", "attention"] as const) {
      expect(isShelved({ column }, archived)).toBe(false);
    }
  });

  it("does not read a record without `archivedAt` as archived", () => {
    expect(isShelved({ column: "done" }, session("s3", undefined))).toBe(false);
  });
});

describe("the Done lane", () => {
  it("hides archived cards, counts only the rest, and offers the way back", async () => {
    const html = doneLane(
      await render(
        [card("kept", "done", "a"), card("gone", "done", "b")],
        [session("a", null), session("b", "2026-09-24T01:00:00.000Z")],
      ),
    );
    expect(html).toContain('data-card="kept"');
    expect(html).not.toContain('data-card="gone"');
    expect(html).toContain('<span class="board-lane-count">1</span>');
    // The sidebar's shelf door, collapsed, with the count as its reason.
    expect(html).toMatch(/class="rail-more board-shelf" aria-expanded="false">Archived<span class="rail-more-count">1</);
    // One visible card: "Archive all" would be the same as its own button.
    expect(html).not.toContain("Archive all finished cards");
  });

  it("offers Archive all once there is more than one card to archive", async () => {
    const html = doneLane(
      await render(
        [card("one", "done", "a"), card("two", "done", "b")],
        [session("a", null), session("b", null)],
      ),
    );
    // In the lane head, as an icon with a name.
    const head = html.slice(0, html.indexOf("</h2>"));
    expect(head).toContain('aria-label="Archive all finished cards"');
    expect(head).toContain("<svg");
    expect(html).not.toContain("board-shelf");
  });

  it("says the lane is archived rather than pretending nothing ever finished", async () => {
    const html = doneLane(
      await render([card("gone", "done", "b")], [session("b", "2026-09-24T01:00:00.000Z")]),
    );
    expect(html).toContain("every finished card is archived.");
    expect(html).not.toContain("finished cards stay as a record of what ran.");
  });
});

describe("the per-card button", () => {
  it("is an icon on Done cards with a thread, and nowhere else", async () => {
    const html = await render(
      [card("fin", "done", "a"), card("run", "working", "b"), card("q", "queued", null)],
      [session("a", null), { ...session("b", null), status: "running" } as SessionRecord],
    );
    const archiveButtons = html.match(/aria-label="Archive"/g) ?? [];
    expect(archiveButtons).toHaveLength(1);
    // Positive control: the button is inside the Done card's top row, next
    // to the time it replaces on hover, and carries no text label.
    const fin = html.slice(html.indexOf('data-card="fin"'));
    const end = fin.slice(fin.indexOf("board-card-end"), fin.indexOf("</article>"));
    expect(end).toMatch(/aria-label="Archive"[^>]*><svg/);
    expect(html).not.toMatch(/>Archive</);
  });
});
