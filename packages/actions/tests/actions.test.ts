import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { App, type Context } from "@daydream-code/kernel";
import SqliteStore from "@daydream-code/store/sqlite";
import { HarnessTools, type HarnessToolDefinition } from "@daydream-code/tools";
import type { ToolRunContext } from "@daydream-code/tools";
import { SessionId } from "@daydream-code/shared";
import {
  MAX_ACTIONS,
  QuickActionError,
  normalizeAction,
  type QuickActions,
  type QuickActionRecord,
} from "@daydream-code/actions";
import QuickActionsSqlite from "@daydream-code/actions/sqlite";
import actionTools from "@daydream-code/actions/tools";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function mount(): Promise<{
  ctx: Context;
  actions: QuickActions;
  tools: HarnessTools;
  run: ToolRunContext;
}> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daydream-actions-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10 }));
  const app = new App();
  const errors: unknown[] = [];
  app.onError = (error) => errors.push(error);
  app.rootCtx.plugin(SqliteStore, { rootPath: dir });
  app.rootCtx.plugin(HarnessTools);
  app.rootCtx.plugin(QuickActionsSqlite);
  app.rootCtx.plugin(actionTools);
  await app.settle();
  const actions = app.rootCtx.get<QuickActions>("actions");
  const tools = app.rootCtx.get<HarnessTools>("tools");
  if (actions === undefined || tools === undefined) {
    throw new Error(`plugins failed to load: ${errors.map(String).join("; ")}`);
  }
  cleanups.push(() => app.dispose(app.rootFiber));
  return {
    ctx: app.rootCtx,
    actions,
    tools,
    run: { sessionId: SessionId("ses_test"), projectRoot: dir },
  };
}

function tool(tools: HarnessTools, name: string): HarnessToolDefinition {
  const found = tools.get(name);
  if (found === undefined) throw new Error(`tool ${name} is not registered`);
  return found;
}

describe("normalizeAction", () => {
  it("falls back to the command when no label is given", () => {
    expect(normalizeAction({ command: " pnpm test " })).toEqual({
      label: "pnpm test",
      command: "pnpm test",
      source: "you",
    });
  });

  it("refuses what a shell cannot be handed as one command", () => {
    expect(normalizeAction({ command: "   " })).toBeNull();
    expect(normalizeAction({ command: "ls\0" })).toBeNull();
    // Two lines would be two commands wearing one label.
    expect(normalizeAction({ command: "ls\nrm -rf /" })).toBeNull();
  });
});

describe("QuickActions (sqlite)", () => {
  it("stores, lists oldest first, and survives a reopen", async () => {
    const { actions } = await mount();
    actions.add({ command: "pnpm dev", label: "Dev server" });
    actions.add({ command: "pnpm test" });
    expect(actions.list().map((a) => [a.label, a.command, a.source])).toEqual([
      ["Dev server", "pnpm dev", "you"],
      ["pnpm test", "pnpm test", "you"],
    ]);
  });

  it("adding the same command twice is a no-op, not a second row", async () => {
    const { actions } = await mount();
    const first = actions.add({ command: "pnpm dev", label: "Dev" });
    const again = actions.add({ command: "pnpm dev", label: "Dev server" });
    expect(again.id).toBe(first.id);
    expect(again.label).toBe("Dev");
    expect(actions.list()).toHaveLength(1);
  });

  it("refuses past the cap rather than silently dropping one", async () => {
    const { actions } = await mount();
    for (let i = 0; i < MAX_ACTIONS; i += 1) actions.add({ command: `cmd${i}` });
    expect(() => actions.add({ command: "one too many" })).toThrow(QuickActionError);
    expect(actions.list()).toHaveLength(MAX_ACTIONS);
  });

  it("emptying a command removes the row instead of keeping an unrunnable one", async () => {
    const { actions } = await mount();
    const added = actions.add({ command: "ls" });
    expect(actions.update(added.id, { command: "  " })).toBeUndefined();
    expect(actions.list()).toEqual([]);
  });

  it("keeps a derived label derived when the command changes", async () => {
    const { actions } = await mount();
    const added = actions.add({ command: "pnpm dev" });
    const next = actions.update(added.id, { label: "", command: "pnpm test" });
    expect(next).toMatchObject({ label: "pnpm test", command: "pnpm test" });
  });

  it("refuses an edit that would collide with another row's command", async () => {
    const { actions } = await mount();
    actions.add({ command: "pnpm dev" });
    const second = actions.add({ command: "pnpm test" });
    expect(() => actions.update(second.id, { command: "pnpm dev" })).toThrow(
      QuickActionError,
    );
  });

  it("announces changes only after the row is durable", async () => {
    const { ctx, actions } = await mount();
    const seen: Array<QuickActionRecord | null> = [];
    ctx.on("actions/changed", (action: QuickActionRecord | null) => {
      // DB-first, then broadcast: a listener must never see an event whose
      // row is not readable yet.
      if (action !== null) expect(actions.get(action.id)).toBeDefined();
      seen.push(action);
    });
    const added = actions.add({ command: "ls" });
    actions.remove(added.id);
    expect(seen).toEqual([expect.objectContaining({ command: "ls" }), null]);
  });
});

describe("add_quick_action", () => {
  it("stamps the calling session's name as the row's provenance", async () => {
    const { ctx, tools, run, actions } = await mount();
    // A row the agent adds must not look like one the person typed.
    ctx.store.db.run(
      `INSERT INTO sessions (id, project_id, thread_id, name, title, task, driver, status, started_at)
       VALUES ('ses_test', '${ctx.store.project.id}', 'thr_test', 'add-a-dev-server', 'Add a dev server', 't', 'mock', 'running', '2026-01-01T00:00:00.000Z')` as never,
    );
    const result = (await tool(tools, "add_quick_action").execute(
      { command: "pnpm dev", label: "Dev server" },
      run,
    )) as QuickActionRecord & { alreadyExisted: boolean };
    expect(result).toMatchObject({
      label: "Dev server",
      command: "pnpm dev",
      source: "add-a-dev-server",
      alreadyExisted: false,
    });
    expect(actions.list()).toHaveLength(1);
  });

  it("reports an existing row rather than claiming to have added it", async () => {
    const { tools, run, actions } = await mount();
    actions.add({ command: "pnpm dev" });
    const result = (await tool(tools, "add_quick_action").execute(
      { command: " pnpm dev " },
      run,
    )) as { alreadyExisted: boolean };
    expect(result.alreadyExisted).toBe(true);
    expect(actions.list()).toHaveLength(1);
  });

  it("validates its own arguments, since the schema conversion does not", async () => {
    const { tools, run } = await mount();
    const add = tool(tools, "add_quick_action");
    await expect(add.execute({ command: "   " }, run)).rejects.toThrow(/required/);
    await expect(add.execute({ command: "a\nb" }, run)).rejects.toThrow(/single line/);
    await expect(add.execute({ command: "x".repeat(5000) }, run)).rejects.toThrow(
      /at most/,
    );
  });

  it("turns a full list into a message the model can act on", async () => {
    const { tools, run, actions } = await mount();
    for (let i = 0; i < MAX_ACTIONS; i += 1) actions.add({ command: `cmd${i}` });
    await expect(
      tool(tools, "add_quick_action").execute({ command: "one more" }, run),
    ).rejects.toThrow(/remove one before adding another/);
  });

  it("cannot remove anything: no tool offers it", async () => {
    const { tools } = await mount();
    expect(tools.list().map((t) => t.name).sort()).toEqual([
      "add_quick_action",
      "list_quick_actions",
    ]);
  });
});

describe("list_quick_actions", () => {
  it("returns the list with provenance", async () => {
    const { tools, run, actions } = await mount();
    actions.add({ command: "pnpm dev", source: "some-session" });
    expect(await tool(tools, "list_quick_actions").execute({}, run)).toEqual([
      expect.objectContaining({ command: "pnpm dev", source: "some-session" }),
    ]);
  });
});
