import { describe, expect, it } from "vitest";
import { z } from "zod";
import { App } from "@daydream-code/kernel";
import type { ModelMessage } from "@daydream-code/shared";
import SessionDrivers from "@daydream-code/driver/registry";
import claudePlugin, {
  ClaudeDriver,
  jsonSchemaToZodShape,
  renderInitialPrompt,
} from "@daydream-code/driver/claude";
import codexPlugin, { CodexDriver } from "@daydream-code/driver/codex";

// NOTE: no network calls anywhere in this file — adapters are only mounted,
// never run.

describe("adapter plugins mount", () => {
  it("registers claude and codex drivers under their ids", async () => {
    const app = new App();
    const errors: unknown[] = [];
    app.onError = (e) => errors.push(e);
    const ctx = app.rootCtx;

    ctx.plugin(SessionDrivers);
    const claudeFiber = ctx.plugin(claudePlugin);
    const codexFiber = ctx.plugin(codexPlugin);
    await app.settle();

    expect(errors).toEqual([]);
    expect(claudeFiber.state).toBe("active");
    expect(codexFiber.state).toBe("active");

    expect(ctx.drivers.get("claude")).toBeInstanceOf(ClaudeDriver);
    expect(ctx.drivers.get("codex")).toBeInstanceOf(CodexDriver);
    expect(ctx.drivers.list().sort()).toEqual(["claude", "codex"]);
  });

  it("stays pending without the drivers registry", async () => {
    const app = new App();
    const ctx = app.rootCtx;
    const fiber = ctx.plugin(claudePlugin);
    await app.settle();
    expect(fiber.state).toBe("pending");
  });

  it("honors a configured driver id", async () => {
    const app = new App();
    const ctx = app.rootCtx;
    ctx.plugin(SessionDrivers);
    ctx.plugin(claudePlugin, { id: "claude-alt" });
    ctx.plugin(codexPlugin, { id: "codex-alt" });
    await app.settle();
    expect(ctx.drivers.get("claude-alt")?.id).toBe("claude-alt");
    expect(ctx.drivers.get("codex-alt")?.id).toBe("codex-alt");
  });
});

describe("jsonSchemaToZodShape", () => {
  const shape = jsonSchemaToZodShape({
    type: "object",
    properties: {
      query: { type: "string", description: "what to search for" },
      limit: { type: "number" },
      exact: { type: "boolean" },
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["query"],
  });
  const schema = z.object(shape);

  it("parses valid args with optional fields omitted", () => {
    expect(schema.parse({ query: "find it" })).toEqual({ query: "find it" });
  });

  it("parses valid args with all fields present", () => {
    const args = { query: "q", limit: 3, exact: true, tags: ["a", "b"] };
    expect(schema.parse(args)).toEqual(args);
  });

  it("rejects a missing required field", () => {
    expect(schema.safeParse({ limit: 3 }).success).toBe(false);
  });

  it("rejects wrong primitive types", () => {
    expect(schema.safeParse({ query: 42 }).success).toBe(false);
    expect(schema.safeParse({ query: "q", limit: "three" }).success).toBe(false);
    expect(schema.safeParse({ query: "q", exact: "yes" }).success).toBe(false);
  });

  it("rejects non-string array items", () => {
    expect(schema.safeParse({ query: "q", tags: [1, 2] }).success).toBe(false);
  });

  it("keeps integer as number", () => {
    const s = z.object(
      jsonSchemaToZodShape({
        type: "object",
        properties: { count: { type: "integer" } },
        required: ["count"],
      }),
    );
    expect(s.parse({ count: 7 })).toEqual({ count: 7 });
    expect(s.safeParse({ count: "7" }).success).toBe(false);
  });

  it("falls back to an open shape for non-object schemas", () => {
    expect(jsonSchemaToZodShape({ type: "string" })).toEqual({});
    expect(jsonSchemaToZodShape({})).toEqual({});
  });
});

describe("renderInitialPrompt", () => {
  it("returns the bare task when context is empty", () => {
    expect(renderInitialPrompt([], "fix the bug")).toBe("fix the bug");
  });

  it("wraps context in a <master-thread> preamble with role labels", () => {
    const context: ModelMessage[] = [
      { role: "user", content: "please add tests" },
      { role: "assistant", content: "dispatched session s_1" },
    ];
    const prompt = renderInitialPrompt(context, "continue the work");
    expect(prompt).toBe(
      "<master-thread>\n" +
        "[user]\nplease add tests\n\n" +
        "[assistant]\ndispatched session s_1\n" +
        "</master-thread>\n\n" +
        "continue the work",
    );
  });

  it("renders structured message parts", () => {
    const context: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "running a tool" },
          { type: "tool_call", toolCallId: "t1", toolName: "search_journal", args: { q: "x" } },
          { type: "tool_result", toolCallId: "t1", toolName: "search_journal", result: [] },
          { type: "marker", text: "[image omitted]" },
        ],
      },
    ];
    const prompt = renderInitialPrompt(context, "task");
    expect(prompt).toContain("running a tool");
    expect(prompt).toContain('[tool_call search_journal {"q":"x"}]');
    expect(prompt).toContain("[tool_result search_journal []]");
    expect(prompt).toContain("[image omitted]");
    expect(prompt.endsWith("task")).toBe(true);
  });
});
