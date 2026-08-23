import { describe, expect, it } from "vitest";
import { App } from "@daydream-code/kernel";
import { SessionId, type JournalEventInput } from "@daydream-code/shared";
import type { HarnessToolDefinition, ToolRunContext } from "@daydream-code/tools";
import type { DriverRunInput, Injection, SessionDriver } from "@daydream-code/driver";
import SessionDrivers from "@daydream-code/driver/registry";
import mockPlugin, { MockDriver } from "@daydream-code/driver/mock";

type SunkEvent = Omit<JournalEventInput, "sessionId">;

function makeInput(overrides: Partial<DriverRunInput> = {}) {
  const events: SunkEvent[] = [];
  const injections: Injection[] = [];
  const input: DriverRunInput = {
    sessionId: SessionId("s_test"),
    workdir: "/tmp/project",
    context: [],
    task: "do the thing",
    modelId: null,
    tools: [],
    onEvent: (event) => events.push(event),
    drainInjections: () => injections.splice(0),
    signal: new AbortController().signal,
    permissionMode: "auto",
    ...overrides,
  };
  return { input, events, injections };
}

async function mountMock(config: unknown): Promise<{ app: App; driver: SessionDriver }> {
  const app = new App();
  const errors: unknown[] = [];
  app.onError = (e) => errors.push(e);
  const ctx = app.rootCtx;
  ctx.plugin(SessionDrivers);
  const fiber = ctx.plugin(mockPlugin, config as never);
  await app.settle();
  expect(errors).toEqual([]);
  expect(fiber.state).toBe("active");
  const driver = ctx.drivers.get("mock");
  expect(driver).toBeDefined();
  return { app, driver: driver! };
}

describe("mock driver", () => {
  it("registers into the SessionDrivers registry via the plugin", async () => {
    const { driver } = await mountMock({ id: "mock", script: [] });
    expect(driver).toBeInstanceOf(MockDriver);
    expect(driver.id).toBe("mock");
  });

  it("defaults id to 'mock' and script to [] with no config", async () => {
    const { driver } = await mountMock(undefined);
    expect(driver.id).toBe("mock");
    const { input, events } = makeInput();
    const result = await driver.run(input);
    expect(events).toEqual([]);
    expect(result.summary).toBe("mock summary: ");
  });

  it("replays turns and tool calls as an exact journal event sequence", async () => {
    const toolCalls: Array<{ args: unknown; run: ToolRunContext }> = [];
    const echo: HarnessToolDefinition = {
      name: "echo",
      description: "echoes text back",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      execute: async (args, run) => {
        toolCalls.push({ args, run });
        return { echoed: args.text };
      },
    };

    const { driver } = await mountMock({
      id: "mock",
      script: [
        { turn: "hello" },
        { tool: "echo", args: { text: "yo" } },
        { turn: "done" },
      ],
    });

    const { input, events } = makeInput({ tools: [echo] });
    const result = await driver.run(input);

    expect(events).toEqual([
      { type: "turn", payload: { text: "hello" } },
      { type: "turn_end", payload: { reason: "end_turn" } },
      { type: "tool_call", payload: { name: "echo", args: { text: "yo" } } },
      { type: "tool_result", payload: { name: "echo", result: { echoed: "yo" } } },
      { type: "turn", payload: { text: "done" } },
      { type: "turn_end", payload: { reason: "end_turn" } },
    ]);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.args).toEqual({ text: "yo" });
    expect(toolCalls[0]!.run).toEqual({
      sessionId: SessionId("s_test"),
      projectRoot: "/tmp/project",
    });

    expect(result).toEqual({
      summary: "mock summary: hello | done",
      tldr: "mock tldr",
      usage: { tokensIn: 10, tokensOut: 5, costUsd: 0 },
    });
  });

  it("drains queued injections at turn boundaries and answers each", async () => {
    const { driver } = await mountMock({
      id: "mock",
      script: [{ turn: "first" }, { turn: "second" }],
    });

    const { input, events, injections } = makeInput();
    injections.push(
      { kind: "user", text: "hey" },
      { kind: "master_update", text: "[master thread update] sibling landed x" },
    );

    const result = await driver.run(input);

    expect(events).toEqual([
      { type: "turn", payload: { text: "first" } },
      { type: "turn_end", payload: { reason: "end_turn" } },
      { type: "user_injected", payload: { kind: "user", text: "hey" } },
      { type: "turn", payload: { text: "ack: hey" } },
      { type: "turn_end", payload: { reason: "end_turn" } },
      {
        type: "user_injected",
        payload: {
          kind: "master_update",
          text: "[master thread update] sibling landed x",
        },
      },
      {
        type: "turn",
        payload: { text: "ack: [master thread update] sibling landed x" },
      },
      { type: "turn_end", payload: { reason: "end_turn" } },
      { type: "turn", payload: { text: "second" } },
      { type: "turn_end", payload: { reason: "end_turn" } },
    ]);

    // Injections consumed: queue empty afterwards.
    expect(injections).toEqual([]);
    expect(result.summary).toBe(
      "mock summary: first | ack: hey | ack: [master thread update] sibling landed x | second",
    );
  });

  it("emits tool_error for an unknown tool and keeps going", async () => {
    const { driver } = await mountMock({
      id: "mock",
      script: [{ tool: "nope" }, { turn: "after" }],
    });
    const { input, events } = makeInput();
    const result = await driver.run(input);
    expect(events).toEqual([
      { type: "tool_call", payload: { name: "nope", args: null } },
      { type: "tool_error", payload: { name: "nope", error: 'unknown tool "nope"' } },
      { type: "turn", payload: { text: "after" } },
      { type: "turn_end", payload: { reason: "end_turn" } },
    ]);
    expect(result.summary).toBe("mock summary: after");
  });

  it("emits tool_error when a tool throws", async () => {
    const bomb: HarnessToolDefinition = {
      name: "bomb",
      description: "always throws",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        throw new Error("kaboom");
      },
    };
    const { driver } = await mountMock({
      id: "mock",
      script: [{ tool: "bomb" }],
    });
    const { input, events } = makeInput({ tools: [bomb] });
    await driver.run(input);
    expect(events).toEqual([
      { type: "tool_call", payload: { name: "bomb", args: null } },
      { type: "tool_error", payload: { name: "bomb", error: "Error: kaboom" } },
    ]);
  });

  it("stops early on an aborted signal but still returns a result", async () => {
    const { driver } = await mountMock({
      id: "mock",
      script: [{ turn: "never emitted" }],
    });
    const controller = new AbortController();
    controller.abort();
    const { input, events } = makeInput({ signal: controller.signal });
    const result = await driver.run(input);
    expect(events).toEqual([]);
    expect(result).toEqual({
      summary: "mock summary: ",
      tldr: "mock tldr",
      usage: { tokensIn: 10, tokensOut: 5, costUsd: 0 },
    });
  });

  it("unregisters the driver when the plugin unloads", async () => {
    const app = new App();
    const ctx = app.rootCtx;
    ctx.plugin(SessionDrivers);
    const fiber = ctx.plugin(mockPlugin, { id: "mock", script: [] } as never);
    await app.settle();
    expect(ctx.drivers.get("mock")).toBeDefined();
    await app.dispose(fiber);
    expect(ctx.drivers.get("mock")).toBeUndefined();
  });
});
