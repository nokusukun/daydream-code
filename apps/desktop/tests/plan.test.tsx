/**
 * Plan mode's pure helpers: the order a plan reads in, which plans are worth
 * resuming, and the reorder a ↑/↓ press sends. The server's `reorder(id,
 * before)` places a card just above `before`, and null is the back of the
 * whole queue.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "@daydream-code/shared";
import type { BoardCard, BoardColumn, BoardPlan } from "../src/api.js";
import { PlanView, openPlans, planNudge, planOrder, planStanding } from "../src/views/PlanView.js";
import { PlanMenu } from "../src/views/PlanMenu.js";

vi.mock("../src/harness.js", () => ({
  useHarness: () => ({
    api: { models: () => Promise.resolve([]) },
    modelLabel: (driver: string, modelId: string | null) => ({ label: modelId ?? driver }),
  }),
}));
// The planner's thread is the real SessionPanel in the app; here it only has
// to prove the workspace mounts the planner's session, not some other one.
vi.mock("../src/views/SessionPanel.js", () => ({
  SessionPanel: (props: { id: string }) => createElement("div", { "data-thread": props.id }),
}));
// ModelSelector reads the stored choice in a render-time initializer.
vi.stubGlobal("localStorage", {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
});

function card(id: string, position: number, planId: string | null, column: BoardColumn = "draft"): BoardCard {
  return {
    id,
    projectId: "p" as never,
    column,
    position,
    title: id,
    task: id,
    request: {},
    sessionId: null,
    evaluatorSessionId: null,
    blockedBy: [],
    attentionReason: null,
    verdict: null,
    planId,
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
  };
}

function plan(id: string, createdAt: string, sessionId: string | null = null): BoardPlan {
  return { id, sessionId: sessionId as never, title: id, request: {}, createdAt };
}

describe("planOrder", () => {
  it("is the plan's own cards, first to run on top", () => {
    const cards = [card("c", 5, "p1"), card("x", 1, null), card("a", 2, "p1"), card("b", 3, "p2")];
    expect(planOrder(cards, "p1").map((c) => c.id)).toEqual(["a", "c"]);
  });
});

describe("planNudge", () => {
  const order = ["a", "b", "c", "d"].map((id, i) => card(id, i + 1, "p"));

  it("up lands just above the card above", () => {
    expect(planNudge(order, 2, -1)).toBe("b");
    expect(planNudge(order, 0, -1)).toBeUndefined();
  });

  it("down lands just above the card two below, or at the back from second-to-last", () => {
    expect(planNudge(order, 1, 1)).toBe("d");
    expect(planNudge(order, 2, 1)).toBeNull();
    expect(planNudge(order, 3, 1)).toBeUndefined();
  });
});

describe("openPlans", () => {
  const live = { status: "running" } as SessionRecord;
  const ended = { status: "completed" } as SessionRecord;

  it("offers plans with unfinished cards or a planner still writing, newest first", () => {
    const plans = [
      plan("drafts", "2026-09-24T01:00:00.000Z", "s1"),
      plan("writing", "2026-09-24T02:00:00.000Z", "s2"),
      plan("running", "2026-09-24T03:00:00.000Z", "s3"),
      plan("finished", "2026-09-24T04:00:00.000Z", "s4"),
    ];
    const cards = [
      card("a", 1, "drafts"),
      // Queued is not finished: its cards still have to run, and that is when
      // a person wants the plan back.
      card("b", 2, "running", "queued"),
      card("c", 3, "running", "done"),
      card("d", 4, "finished", "done"),
    ];
    const sessions: Record<string, SessionRecord> = { s1: ended, s2: live, s3: ended, s4: ended };
    const result = openPlans(plans, cards, (p) => (p.sessionId === null ? undefined : sessions[p.sessionId]));
    expect(result.map((p) => p.id)).toEqual(["running", "writing", "drafts"]);
  });
});

describe("planStanding", () => {
  const p = plan("p", "2026-09-24T01:00:00.000Z", "s");

  it("counts drafts while any are left to review", () => {
    const cards = [card("a", 1, "p"), card("b", 2, "p"), card("c", 3, "p", "queued")];
    expect(planStanding(p, cards, undefined)).toEqual({ glyph: "draft", meta: "2 drafts" });
  });

  it("counts progress through the queued work once none are", () => {
    const cards = [card("a", 1, "p", "done"), card("b", 2, "p", "working"), card("c", 3, "p", "queued")];
    expect(planStanding(p, cards, undefined)).toEqual({ glyph: "running", meta: "1 of 3 done" });
  });

  it("is still writing before the planner's first card lands", () => {
    expect(planStanding(p, [], { status: "running" } as SessionRecord)).toEqual({ glyph: "running", meta: "writing" });
  });
});

describe("PlanMenu", () => {
  const p = { ...plan("p1", "2026-09-24T01:00:00.000Z", null), title: "Ship widgets" };
  const render = (cards: BoardCard[]) =>
    renderToStaticMarkup(
      createElement(PlanMenu, { plans: [p], cards, sessions: new Map(), onOpen: () => undefined }),
    );

  it("is a plain button while no plan is going", () => {
    const html = render([card("a", 1, "p1", "done")]);
    expect(html).toContain(">Plan</button>");
    expect(html).not.toContain("aria-haspopup");
  });

  it("becomes a pull-down counting the plans in progress once one is", () => {
    const html = render([card("a", 1, "p1", "queued")]);
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('<span class="plan-menu-count">1</span>');
  });
});

describe("the plan screens", () => {
  const planned = plan("p1", "2026-09-24T01:00:00.000Z", "ses_planner");
  const sessions = new Map<string, SessionRecord>([
    ["ses_planner", { id: "ses_planner", status: "completed" } as SessionRecord],
  ]);
  const render = (planId: string, cards: BoardCard[]) =>
    renderToStaticMarkup(
      createElement(PlanView, {
        planId,
        plans: [{ ...planned, title: "Ship widgets" }],
        cards,
        sessions,
        onOpen: vi.fn(),
        onClose: vi.fn(),
      }),
    );

  it("lists the plan in run order beside its planner's thread, and queues only the drafts", () => {
    const html = render("p1", [
      card("second", 3, "p1"),
      card("first", 2, "p1", "queued"),
      card("third", 4, "p1"),
      card("elsewhere", 1, null),
    ]);
    expect(html).toContain("Ship widgets");
    expect(html).toContain('data-thread="ses_planner"');
    const order = [...html.matchAll(/plan-card-title">([^<]+)</g)].map((m) => m[1]);
    expect(order).toEqual(["first", "second", "third"]);
    // A card the person already queued is shown, locked, with where it went.
    expect(html).toMatch(/plan-card is-locked[\s\S]*?plan-card-lane">queued</);
    expect(html).toContain("Queue 2 cards");
    expect(html).not.toContain("elsewhere");
  });

  it("offers the plans still in progress on the composer", () => {
    const html = render("new", [card("a", 1, "p1")]);
    expect(html).toContain("Draft cards");
    expect(html).toContain("In progress");
    expect(html).toContain("1 draft");
  });

  it("says so when the plan it was asked for is gone", () => {
    expect(render("p_missing", [])).toContain("Plan not found");
  });
});
