import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { boot, type BootResult } from "@daydream-code/boot";

/**
 * Reasoning effort rides the same rails as modelId: pinned at dispatch,
 * stored on the session row, journaled in `session_started`, handed to the
 * driver, and carried across a revive. The mock driver ignores the value, so
 * these tests assert the harness's half of the contract — the journal row is
 * built from the same record the driver receives.
 */

let dirs: string[] = [];
let systems: BootResult[] = [];

async function bootProject(): Promise<BootResult> {
  const dir = mkdtempSync(join(tmpdir(), "ddc-effort-"));
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

function startedPayloads(system: BootResult, sessionId: string) {
  return system.ctx.journal
    .read({ sessionId: sessionId as never })
    .filter((event) => event.type === "session_started")
    .map((event) => event.payload as { effort?: string | null });
}

describe("reasoning effort through the session lifecycle", () => {
  it("pins the dispatched level on the record and in session_started", async () => {
    const system = await bootProject();
    const handle = await system.ctx.sessions.dispatch({
      task: "think hard about this",
      driver: "mock",
      effort: "xhigh",
    });
    expect(handle.record.effort).toBe("xhigh");
    const record = await handle.done;
    expect(record.effort).toBe("xhigh");
    const payloads = startedPayloads(system, record.id);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.effort).toBe("xhigh");
  });

  it("stores null when no level is chosen — the driver default, not a frozen one", async () => {
    const system = await bootProject();
    const handle = await system.ctx.sessions.dispatch({
      task: "just do it",
      driver: "mock",
    });
    expect(handle.record.effort).toBeNull();
    await handle.done;
    expect(startedPayloads(system, handle.record.id)[0]?.effort).toBeNull();
  });

  it("keeps the pinned level across a revive", async () => {
    const system = await bootProject();
    const first = await system.ctx.sessions.dispatch({
      task: "round one",
      driver: "mock",
      effort: "low",
    });
    await first.done;
    const second = await system.ctx.sessions.continueSession(
      first.record.id,
      "round two",
    );
    expect(second.record.effort).toBe("low");
    await second.done;
    const payloads = startedPayloads(system, first.record.id);
    expect(payloads).toHaveLength(2);
    expect(payloads[1]?.effort).toBe("low");
  });
});
