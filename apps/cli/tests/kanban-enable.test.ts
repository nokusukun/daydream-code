import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { boot, type BootResult } from "@daydream-code/boot";
import type {} from "@daydream-code/settings";
import type {} from "@daydream-code/routes";

/**
 * End-to-end pin for the board screen's "Turn on kanban mode" switch: the
 * four kanban rows, written to the project layer through the settings
 * service, must mount live — no restart — and `/api/board` must start
 * answering. If any of these rows ever becomes restart-required, the switch
 * degrades into a message, and this test is the early warning.
 */

const KANBAN_ROWS = ["board", "board-evaluator", "board-writeback", "board-routes"] as const;

let dirs: string[] = [];
let systems: BootResult[] = [];

afterEach(async () => {
  for (const system of systems) {
    await system.app.dispose(system.app.rootFiber).catch(() => undefined);
  }
  systems = [];
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  dirs = [];
});

describe("enabling kanban from the board screen", () => {
  it("mounts the four rows live and /api/board starts answering", async () => {
    const root = mkdtempSync(join(tmpdir(), "ddc-kanban-"));
    dirs.push(root);
    const system = await boot({
      projectRoot: root,
      overrides: [
        { id: "driver-mock", disabled: false, config: { id: "mock", script: [] } },
        { id: "driver-claude", disabled: true },
      ],
    });
    systems.push(system);
    const { ctx } = system;

    // Off by default: the route the board polls does not exist.
    expect(ctx.routes.match("GET", "/api/board")).toBeUndefined();

    // The exact writes the board screen's switch performs.
    for (const id of KANBAN_ROWS) {
      const result = await ctx.settings.write({
        layer: "project",
        id,
        set: { disabled: false },
      });
      const outcome = result.outcomes.find((candidate) => candidate.id === id);
      expect(outcome?.status, id).toBe("mounted");
    }

    const match = ctx.routes.match("GET", "/api/board");
    expect(match).toBeDefined();
    const body = (await match!.route.handle({
      method: "GET",
      path: "/api/board",
      params: match!.params,
      query: {},
      headers: {},
      body: undefined,
    })) as { enabled: boolean; cards: unknown[] };
    expect(body.enabled).toBe(true);
    expect(body.cards).toEqual([]);

    // The switch is a real settings write: the project layer file now says
    // so, which is why the Settings window agrees with the board afterwards.
    const layer = readFileSync(join(root, ".daydream-code", "config.yml"), "utf8");
    for (const id of KANBAN_ROWS) expect(layer).toContain(id);
  });
});
