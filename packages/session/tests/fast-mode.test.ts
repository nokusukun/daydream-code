import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { boot, type BootResult } from "@daydream-code/boot";
import type { DriverRunInput } from "@daydream-code/driver";

let dirs: string[] = [];
let systems: BootResult[] = [];

async function bootProject(): Promise<BootResult> {
  const dir = mkdtempSync(join(tmpdir(), "ddc-fast-mode-"));
  dirs.push(dir);
  const result = await boot({
    projectRoot: dir,
    overrides: [
      { id: "driver-mock", disabled: false, config: { id: "mock", script: [] } },
      { id: "driver-claude", disabled: true },
    ],
  });
  systems.push(result);
  return result;
}

afterEach(async () => {
  for (const system of systems) {
    await system.app.dispose(system.app.rootFiber).catch(() => undefined);
  }
  systems = [];
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function registerFastDriver(system: BootResult): boolean[] {
  const seen: boolean[] = [];
  system.ctx.drivers.register(system.ctx, {
    id: "fast-mock",
    supportsFastMode: true,
    run: async (input: DriverRunInput) => {
      seen.push(input.fastMode);
      return {
        summary: "done",
        tldr: "done",
        usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
      };
    },
  });
  return seen;
}

function startedModes(system: BootResult, sessionId: string): boolean[] {
  return system.ctx.journal
    .read({ sessionId: sessionId as never })
    .filter((event) => event.type === "session_started")
    .map((event) => (event.payload as { fastMode?: boolean }).fastMode === true);
}

describe("fast mode through the session lifecycle", () => {
  it("persists, reaches the driver, survives a revive, and can be turned off", async () => {
    const system = await bootProject();
    const seen = registerFastDriver(system);
    const first = await system.ctx.sessions.dispatch({
      task: "run quickly",
      driver: "fast-mock",
      fastMode: true,
    });
    expect(first.record.fastMode).toBe(true);
    await first.done;

    const second = await system.ctx.sessions.continueSession(
      first.record.id,
      "keep going quickly",
    );
    await second.done;
    expect(second.record.fastMode).toBe(true);

    const standard = system.ctx.sessions.setModel(first.record.id, {
      fastMode: false,
    });
    expect(standard.fastMode).toBe(false);
    const third = await system.ctx.sessions.continueSession(
      first.record.id,
      "use standard speed",
    );
    await third.done;

    expect(seen).toEqual([true, true, false]);
    expect(startedModes(system, first.record.id)).toEqual([true, true, false]);
  });

  it("rejects fast mode before storing a thread for an unsupported driver", async () => {
    const system = await bootProject();
    await expect(
      system.ctx.sessions.dispatch({
        task: "unsupported speed",
        driver: "mock",
        fastMode: true,
      }),
    ).rejects.toThrow(/does not support fast mode/);
    expect(system.ctx.sessions.list()).toHaveLength(0);

    const standard = await system.ctx.sessions.dispatch({
      task: "standard speed",
      driver: "mock",
    });
    await standard.done;
    expect(() =>
      system.ctx.sessions.setModel(standard.record.id, { fastMode: true }),
    ).toThrow(/does not support fast mode/);
    expect(system.ctx.sessions.get(standard.record.id)?.fastMode).toBe(false);
  });
});
