import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { boot, type BootResult } from "@daydream-code/boot";

let dir: string | null = null;
let system: BootResult | null = null;

afterEach(async () => {
  if (system !== null) {
    await system.app.dispose(system.app.rootFiber).catch(() => undefined);
    system = null;
  }
  if (dir !== null) {
    rmSync(dir, { recursive: true, force: true });
    dir = null;
  }
});

describe("cycle title journal snapshots", () => {
  it("records the generated title at both ends of every run", async () => {
    dir = mkdtempSync(join(tmpdir(), "ddc-cycle-title-"));
    system = await boot({
      projectRoot: dir,
      overrides: [
        { id: "driver-claude", disabled: true },
        { id: "driver-mock", disabled: false, config: { id: "mock", script: [] } },
      ],
    });

    const first = await system.ctx.sessions.dispatch({
      task: "Repair the narrow toolbar. Keep the controls accessible.",
      driver: "mock",
    });
    await first.done;
    const second = await system.ctx.sessions.continueSession(
      first.record.id,
      "Add the cycle title boundaries. Verify both edges.",
    );
    await second.done;

    const lifecycle = system.ctx.journal
      .read({ sessionId: first.record.id })
      .filter(
        (event) =>
          event.type === "session_started" || event.type === "session_ended",
      )
      .map((event) => ({
        type: event.type,
        title: (event.payload as { title?: unknown }).title,
      }));

    expect(lifecycle).toEqual([
      { type: "session_started", title: "Repair the narrow toolbar" },
      { type: "session_ended", title: "Repair the narrow toolbar" },
      { type: "session_started", title: "Add the cycle title boundaries" },
      { type: "session_ended", title: "Add the cycle title boundaries" },
    ]);
  });
});
