import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { boot, type BootResult } from "@daydream-code/boot";
import { LIVE_STATUSES, ThreadId } from "@daydream-code/shared";
import type { HttpRoutes, RouteRequest } from "@daydream-code/routes";
import type { BoardCard, BoardPlan } from "@daydream-code/board";
import type {} from "@daydream-code/board";

/**
 * End-to-end for plan mode: a planner session turns one prompt into draft
 * cards through `board_plan_write`, the person refines and queues them, and
 * the planner's thread stays a thread, not a card.
 *
 * The planner runs on `mock-plan`, whose script is the planner's tool calls.
 * Cards run on `mock`, and the evaluator hangs, so a queued plan can be
 * inspected in Evaluating without anything running.
 */

let dirs: string[] = [];
let systems: BootResult[] = [];

async function bootProject(options: {
  root?: string;
  planner: unknown[];
  evaluator?: unknown[];
}): Promise<BootResult & { call: Call; release(): void }> {
  const dir = options.root ?? mkdtempSync(join(tmpdir(), "ddc-plan-"));
  if (options.root === undefined) dirs.push(dir);
  const result = await boot({
    projectRoot: dir,
    overrides: [
      { id: "driver-claude", disabled: true },
      { id: "driver-mock", disabled: false, config: { id: "mock", script: [] } },
      {
        id: "driver-mock-plan",
        name: "@daydream-code/driver/mock",
        config: { id: "mock-plan", script: options.planner },
      },
      {
        id: "driver-mock-eval",
        name: "@daydream-code/driver/mock",
        config: { id: "mock-eval", script: options.evaluator ?? [{ tool: "hang" }] },
      },
      { id: "board", disabled: false },
      {
        id: "board-evaluator",
        disabled: false,
        config: { driver: "mock-eval", timeoutMs: 60_000, skipWhenIdle: false },
      },
      { id: "board-writeback", disabled: false },
      { id: "board-routes", disabled: false },
      { id: "board-planner", disabled: false },
    ],
  });
  systems.push(result);

  let waiters: Array<() => void> = [];
  result.ctx.tools.register(result.ctx, {
    name: "hang",
    description: "test only: block until released",
    parameters: { type: "object", properties: {} },
    execute: () => new Promise<unknown>((resolve) => waiters.push(() => resolve({ released: true }))),
  });
  const release = () => {
    const pending = waiters;
    waiters = [];
    for (const w of pending) w();
  };

  const routes = result.ctx.get<HttpRoutes>("routes")!;
  const call: Call = async (method, path, body) => {
    const match = routes.match(method, path);
    if (match === undefined) throw new Error(`no route for ${method} ${path}`);
    return match.route.handle({ method, path, params: match.params, query: {}, headers: {}, body } as RouteRequest);
  };
  return Object.assign(result, { call, release });
}

type Call = (method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown) => Promise<unknown>;

afterEach(async () => {
  for (const system of systems) {
    (system as { release?: () => void }).release?.();
    await until("runs to drain", () => system.ctx.sessions.running().length === 0, 2_000).catch(() => undefined);
    await system.app.dispose(system.app.rootFiber).catch(() => undefined);
  }
  systems = [];
  for (const dir of dirs) {
    const started = Date.now();
    for (;;) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch (error) {
        if (Date.now() - started > 10_000) throw error;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }
  dirs = [];
});

async function until(what: string, predicate: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const write = (changes: unknown[]) => ({ tool: "board_plan_write", args: { changes } });

/** Start a plan over HTTP and wait for its planner's run to finish. */
async function plan(system: BootResult & { call: Call }, prompt: string): Promise<BoardPlan> {
  const created = (await system.call("POST", "/api/board/plans", { prompt, driver: "mock-plan" })) as BoardPlan;
  expect(created.sessionId).not.toBeNull();
  await until("planner to finish", () => {
    const planner = system.ctx.sessions.get(created.sessionId!);
    return planner !== undefined && !LIVE_STATUSES.includes(planner.status);
  });
  return created;
}

describe("plan mode", () => {
  it("a planner turns one prompt into ordered draft cards, and is not a card itself", async () => {
    const system = await bootProject({
      planner: [
        write([
          { action: "add", title: "Schema first", task: "Add the widgets table and its migration." },
          { action: "add", title: "Widget API", task: "Expose GET /api/widgets over the new table." },
          { action: "add", task: "Render the widget list in the desktop app." },
        ]),
        { turn: "three cards, schema first" },
      ],
    });
    const { ctx } = system;
    const created = await plan(system, "Build widgets end to end.");

    const cards = ctx.board.planCards(created.id);
    expect(cards.map((c) => c.title)).toEqual([
      "Schema first",
      "Widget API",
      "Render the widget list in the desktop app",
    ]);
    expect(cards.every((c) => c.column === "draft" && c.planId === created.id)).toBe(true);
    // Every card runs on the agent the person picked for the plan.
    expect(cards.every((c) => c.request.driver === "mock-plan")).toBe(true);
    // The planner is a thread, not a card, and its task names its plan.
    expect(ctx.board.forSession(created.sessionId!)).toBeUndefined();
    expect(ctx.board.list()).toHaveLength(3);
    expect(created.title).toBe("Build widgets end to end");
    expect(ctx.sessions.get(created.sessionId!)!.task).toMatch(/^Plan: Build widgets end to end\n\[board plan plan_/);
    expect(ctx.sessions.get(created.sessionId!)!.task).toContain("Build widgets end to end.");
    // Drafts are the board's own business: nothing about them on master.
    const notes = ctx.threads
      .entries(ThreadId(ctx.threads.ensureMaster().id))
      .filter((e) => e.kind === "note")
      .map((e) => String(e.message.content));
    expect(notes.filter((n) => n.includes("card "))).toEqual([]);

    expect(await system.call("GET", "/api/board/plans")).toEqual([
      expect.objectContaining({ id: created.id, sessionId: created.sessionId }),
    ]);
  });

  it("changes are all or nothing, and only a plan's own drafts can be changed", async () => {
    const system = await bootProject({ planner: [write([{ action: "add", task: "first" }])] });
    const { ctx } = system;
    const created = await plan(system, "one card");
    const stranger = ctx.board.create({ task: "someone else's draft", draft: true });
    const [card] = ctx.board.planCards(created.id);

    // The second change is invalid, so the rename must not land either.
    const out = (await ctx.tools.get("board_plan_write")!.execute(
      {
        changes: [
          { action: "update", id: card!.id, title: "renamed" },
          { action: "remove", id: stranger.id },
        ],
      },
      { sessionId: created.sessionId!, projectRoot: "/" },
    )) as { status: string; detail: string };
    expect(out.status).toBe("refused");
    expect(out.detail).toContain("not a card of this plan");
    expect(ctx.board.get(card!.id)?.title).toBe("first");
    expect(ctx.board.get(stranger.id)?.column).toBe("draft");
  });

  it("a session that is not a planner is refused", async () => {
    const system = await bootProject({ planner: [] });
    const out = await system.ctx.tools.get("board_plan_write")!.execute(
      { changes: [{ action: "add", task: "sneak in" }] },
      { sessionId: "sess_nobody", projectRoot: "/" },
    );
    expect(out).toMatchObject({ status: "refused", reason: "not-a-planner" });
    expect(system.ctx.board.list()).toEqual([]);
  });

  it("before places cards, and a hand edit keeps the planner's title", async () => {
    const system = await bootProject({
      planner: [write([{ action: "add", title: "Last", task: "last task" }])],
    });
    const { ctx } = system;
    const created = await plan(system, "order matters");
    const last = ctx.board.planCards(created.id)[0]!;

    const tool = ctx.tools.get("board_plan_write")!;
    const run = { sessionId: created.sessionId!, projectRoot: "/" };
    await tool.execute(
      {
        changes: [
          { action: "add", title: "First", task: "first task", before: last.id },
          { action: "add", title: "Second", task: "second task", before: last.id },
        ],
      },
      run,
    );
    expect(ctx.board.planCards(created.id).map((c) => c.title)).toEqual(["First", "Second", "Last"]);
    const first = ctx.board.planCards(created.id)[0]!;
    await tool.execute({ changes: [{ action: "update", id: first.id, before: "end" }] }, run);
    expect(ctx.board.planCards(created.id).map((c) => c.title)).toEqual(["Second", "Last", "First"]);

    // The person fixes the task by hand. The title the planner chose stays,
    // and the edit reaches board mirrors like any other write.
    const seen: BoardCard[] = [];
    ctx.on("board/moved", (card: BoardCard) => seen.push(card));
    const edited = ctx.board.update(first.id, { task: "first task, fixed" });
    expect(edited.title).toBe("First");
    expect(seen.map((c) => c.task)).toEqual(["first task, fixed"]);
  });

  it("queuing a plan moves its drafts behind newer work, in plan order, and evaluates the head", async () => {
    const system = await bootProject({
      planner: [write([{ action: "add", task: "plan one" }, { action: "add", task: "plan two" }])],
    });
    const { ctx } = system;
    const created = await plan(system, "two steps");
    // Queued while the plan was under review: it must stay ahead of the plan.
    const newer = ctx.board.create({ task: "queued meanwhile", draft: true });

    const queued = (await system.call("POST", `/api/board/plans/${created.id}/submit`)) as BoardCard[];
    expect(queued.map((c) => c.task)).toEqual(["plan one", "plan two"]);
    const [one, two] = ctx.board.planCards(created.id);
    expect(one!.position).toBeGreaterThan(newer.position);
    expect(two!.position).toBeGreaterThan(one!.position);
    await until("the plan's head to evaluate", () => ctx.board.get(one!.id)?.column === "evaluating");
    expect(["queued", "evaluating"]).toContain(ctx.board.get(two!.id)?.column);

    // Queued cards are the person's now; the planner can see but not touch them.
    const out = (await ctx.tools.get("board_plan_write")!.execute(
      { changes: [{ action: "remove", id: two!.id }] },
      { sessionId: created.sessionId!, projectRoot: "/" },
    )) as { status: string; detail: string };
    expect(out.status).toBe("refused");
    expect(out.detail).toMatch(/only they can change it now/);
  });

  it("discarding a plan cancels its drafts only", async () => {
    const system = await bootProject({
      planner: [write([{ action: "add", task: "keep me" }, { action: "add", task: "drop me" }])],
    });
    const { ctx } = system;
    const created = await plan(system, "partly");
    const [keep] = ctx.board.planCards(created.id);
    ctx.board.submit(keep!.id);

    const removed = (await system.call("DELETE", `/api/board/plans/${created.id}`)) as BoardCard[];
    expect(removed.map((c) => c.task)).toEqual(["drop me"]);
    expect(ctx.board.planCards(created.id).map((c) => c.task)).toEqual(["keep me"]);
  });

  it("replying to the planner continues its thread, and the plan survives a restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "ddc-plan-restart-"));
    dirs.push(root);
    const script = [write([{ action: "add", task: "a card per run" }])];
    const first = await bootProject({ root, planner: script });
    const created = await plan(first, "refine me");
    expect(first.ctx.board.planCards(created.id)).toHaveLength(1);
    await first.app.dispose(first.app.rootFiber);
    systems = systems.filter((s) => s !== first);

    const second = await bootProject({ root, planner: script });
    const { ctx } = second;
    expect(ctx.board.planFor(created.sessionId!)?.id).toBe(created.id);
    // The board's continue intercept only re-queues cards; a planner is not one.
    await ctx.sessions.continueSession(created.sessionId!, "split it further");
    await until("second planner run", () => ctx.board.planCards(created.id).length === 2);
    expect(ctx.board.list().filter((c) => c.planId === null)).toEqual([]);
  });
  it("the planner queues only once the person has replied, never on its first run", async () => {
    const system = await bootProject({
      planner: [write([{ action: "add", task: "one more card" }]), { tool: "board_plan_queue" }],
    });
    const { ctx } = system;
    const created = await plan(system, "queue it when you're done");
    const planner = created.sessionId!;
    const queueResults = () =>
      ctx.journal
        .read({ sessionId: planner })
        .filter((e) => e.type === "tool_result" && (e.payload as { name?: string }).name === "board_plan_queue")
        .map((e) => (e.payload as { result: { status: string; reason?: string } }).result);

    // The prompt asked for it, but the person has not seen a draft yet.
    expect(queueResults()).toEqual([expect.objectContaining({ status: "refused", reason: "not-reviewed" })]);
    expect(ctx.board.planCards(created.id).map((c) => c.column)).toEqual(["draft"]);

    // A sibling's message is not the person's.
    await ctx.sessions.continueSession(planner, "queue it", undefined, "message", ["ses_sibling" as never]);
    await until("the relayed run", () => queueResults().length === 2);
    await until("planner idle", () => !LIVE_STATUSES.includes(ctx.sessions.get(planner)!.status));
    expect(queueResults()[1]).toMatchObject({ status: "refused", reason: "not-reviewed" });

    await ctx.sessions.continueSession(planner, "looks good, queue it");
    await until("the queue", () => queueResults().length === 3);
    expect(queueResults()[2]).toMatchObject({ status: "queued" });
    const cards = ctx.board.planCards(created.id);
    expect(cards).toHaveLength(3);
    expect(cards.every((c) => c.column !== "draft")).toBe(true);

    // Its own plan's cards moving is not news the planner is woken by.
    const notes = ctx.threads
      .entries(ThreadId(ctx.threads.ensureMaster().id))
      .filter((e) => e.kind === "note" && String(e.message.content).includes("queued on the board"));
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.every((e) => e.causedBy?.includes(planner))).toBe(true);
  });
});
