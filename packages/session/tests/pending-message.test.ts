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

  it("releases multiple queued messages one run at a time, in order", async () => {
    dir = mkdtempSync(join(tmpdir(), "ddc-next-message-"));
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
      description: "Pause until released.",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        await held;
        return { released: true };
      },
    });

    const handle = await ctx.sessions.dispatch({ task: "first", driver: "mock" });
    const second = ctx.sessions.enqueueNextMessage(handle.record.id, "second");
    const third = ctx.sessions.enqueueNextMessage(handle.record.id, "third");
    const fourth = ctx.sessions.enqueueNextMessage(handle.record.id, "fourth");
    expect(ctx.sessions.nextMessages(handle.record.id)).toEqual([
      second,
      third,
      fourth,
    ]);
    expect(
      ctx.journal
        .read({ sessionId: handle.record.id })
        .filter((event) => event.type === "session_started"),
    ).toHaveLength(1);
    expect(
      ctx.journal
        .read({ sessionId: handle.record.id })
        .some((event) => event.type === "user_injected"),
    ).toBe(false);

    const drained = new Promise<void>((resolve) => {
      const off = ctx.on("journal/append", (event) => {
        if (
          event.sessionId === handle.record.id &&
          event.type === "session_started" &&
          (event.payload as { task?: unknown }).task === "fourth"
        ) {
          off();
          resolve();
        }
      });
    });
    release();
    await handle.done;
    await drained;

    const events = ctx.journal.read({ sessionId: handle.record.id });
    const ended = events.findIndex((event) => event.type === "session_ended");
    const released = events.findIndex((event) => event.type === "user_message_released");
    const secondStarted = events.findIndex(
      (event) =>
        event.type === "session_started" &&
        (event.payload as { task?: unknown }).task === "second",
    );
    expect(ended).toBeGreaterThanOrEqual(0);
    expect(released).toBeGreaterThan(ended);
    expect(secondStarted).toBeGreaterThan(released);
    expect(
      events
        .filter((event) => event.type === "session_started")
        .map((event) => (event.payload as { task?: unknown }).task),
    ).toEqual(["first", "second", "third", "fourth"]);
    expect(ctx.sessions.nextMessages(handle.record.id)).toEqual([]);
  });

  it("pauses a completed run while the next message is being edited", async () => {
    dir = mkdtempSync(join(tmpdir(), "ddc-cancel-next-"));
    system = await boot({
      projectRoot: dir,
      overrides: [
        { id: "driver-claude", disabled: true },
        {
          id: "driver-mock",
          disabled: false,
          config: { id: "mock", script: [{ tool: "hold" }, { turn: "done" }] },
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
      description: "Pause until released.",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        await held;
        return { released: true };
      },
    });

    const handle = await ctx.sessions.dispatch({ task: "first", driver: "mock" });
    const next = ctx.sessions.enqueueNextMessage(handle.record.id, "old wording");
    ctx.sessions.enqueueNextMessage(handle.record.id, "after the edit");
    expect(
      ctx.sessions.beginNextMessageEdit(handle.record.id, next.deliveryId),
    ).toMatchObject({ editing: true });
    release();
    await handle.done;
    await Promise.resolve();

    expect(
      ctx.journal
        .read({ sessionId: handle.record.id })
        .filter((event) => event.type === "session_started"),
    ).toHaveLength(1);

    const drained = new Promise<void>((resolve) => {
      const off = ctx.on("journal/append", (event) => {
        if (
          event.sessionId === handle.record.id &&
          event.type === "session_started" &&
          (event.payload as { task?: unknown }).task === "after the edit"
        ) {
          off();
          resolve();
        }
      });
    });
    expect(
      ctx.sessions.updateNextMessage(
        handle.record.id,
        next.deliveryId,
        "new wording",
      ),
    ).toMatchObject({ message: "new wording", editing: false });
    await drained;
    expect(
      ctx.journal
        .read({ sessionId: handle.record.id })
        .filter((event) => event.type === "session_started")
        .map((event) => (event.payload as { task?: unknown }).task),
    ).toEqual(["first", "new wording", "after the edit"]);
  });

  it("cancels one queued message without disturbing the rest", async () => {
    dir = mkdtempSync(join(tmpdir(), "ddc-cancel-next-"));
    system = await boot({
      projectRoot: dir,
      overrides: [
        { id: "driver-claude", disabled: true },
        {
          id: "driver-mock",
          disabled: false,
          config: { id: "mock", script: [{ tool: "hold" }, { turn: "done" }] },
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
      description: "Pause until released.",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        await held;
        return { released: true };
      },
    });

    const handle = await ctx.sessions.dispatch({ task: "first", driver: "mock" });
    const keep = ctx.sessions.enqueueNextMessage(handle.record.id, "keep this");
    const remove = ctx.sessions.enqueueNextMessage(handle.record.id, "remove this");
    expect(ctx.sessions.cancelNextMessage(handle.record.id, remove.deliveryId)).toBe(true);
    expect(ctx.sessions.cancelNextMessage(handle.record.id, remove.deliveryId)).toBe(false);
    expect(ctx.sessions.nextMessages(handle.record.id)).toEqual([keep]);

    release();
    await handle.done;
    expect(ctx.journal.read({ sessionId: handle.record.id })).toContainEqual(
      expect.objectContaining({
        type: "user_message_cancelled",
        payload: expect.objectContaining({ deliveryId: remove.deliveryId }),
      }),
    );
  });
});
