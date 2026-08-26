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

describe("pending user messages", () => {
  it("journals acceptance immediately and retires it when the driver drains", async () => {
    dir = mkdtempSync(join(tmpdir(), "ddc-pending-message-"));
    system = await boot({
      projectRoot: dir,
      overrides: [
        { id: "driver-claude", disabled: true },
        {
          id: "driver-mock",
          disabled: false,
          config: {
            id: "mock",
            script: [{ tool: "hold" }, { turn: "finished" }],
          },
        },
      ],
    });
    const { ctx } = system;

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    ctx.tools.register(ctx, {
      name: "hold",
      description: "Pause the scripted run until the test releases it.",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        await held;
        return { released: true };
      },
    });

    const handle = await ctx.sessions.dispatch({
      task: "wait for another message",
      driver: "mock",
    });
    await ctx.sessions.continueSession(
      handle.record.id,
      "also check the retry path",
    );

    const accepted = ctx.journal
      .read({ sessionId: handle.record.id })
      .find((event) => event.type === "user_message_queued");
    expect(accepted?.payload).toMatchObject({
      text: "also check the retry path",
    });
    expect(
      ctx.journal
        .read({ sessionId: handle.record.id })
        .some((event) => event.type === "user_injected"),
    ).toBe(false);

    release();
    await handle.done;

    const events = ctx.journal.read({ sessionId: handle.record.id });
    const deliveryId = (accepted?.payload as { deliveryId?: string }).deliveryId;
    expect(deliveryId).toMatch(/^msg_/);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "user_injected",
        payload: expect.objectContaining({
          deliveryId,
          text: "also check the retry path",
        }),
      }),
    );
  });
});
