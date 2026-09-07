import { describe, expect, it } from "vitest";
import { z } from "zod";
import { App } from "@daydream-code/kernel";
import type { ModelMessage } from "@daydream-code/shared";
import HttpRoutes from "@daydream-code/routes/registry";
import SessionDrivers from "@daydream-code/driver/registry";
import driverRoutes from "@daydream-code/driver/routes";
import claudePlugin, {
  ClaudeDriver,
  claudeFastSettings,
  jsonSchemaToZodShape,
  renderInitialPrompt,
} from "@daydream-code/driver/claude";
import codexPlugin, {
  CodexDriver,
  codexErrorMessage,
  codexServiceTier,
} from "@daydream-code/driver/codex";
import type { DriverRunInput } from "@daydream-code/driver";
import { SessionId } from "@daydream-code/shared";

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

  it("serves each adapter's model catalog, replaceable via config", async () => {
    const app = new App();
    const ctx = app.rootCtx;
    ctx.plugin(SessionDrivers);
    ctx.plugin(claudePlugin);
    ctx.plugin(codexPlugin, {
      id: "codex",
      models: [{ id: "custom-1", label: "Custom One", isDefault: true }],
    });
    await app.settle();

    const catalog = ctx.drivers.catalog();
    const claude = catalog.find((entry) => entry.driver === "claude");
    expect(claude?.models.map((m) => m.id)).toContain("claude-opus-5");
    expect(claude?.supportsFastMode).toBe(true);
    const codex = catalog.find((entry) => entry.driver === "codex");
    expect(codex?.supportsFastMode).toBe(true);
    expect(codex?.models).toEqual([
      { id: "custom-1", label: "Custom One", isDefault: true },
    ]);
  });

  it("delegates skill discovery to the selected driver and project root", async () => {
    const app = new App();
    const ctx = app.rootCtx;
    ctx.plugin(SessionDrivers);
    await app.settle();
    const calls: string[] = [];
    ctx.drivers.register(ctx, {
      id: "skilled",
      skills: async (workdir) => {
        calls.push(workdir);
        return [{
          name: "verify",
          invocation: "/",
          description: "Prove the change works",
        }];
      },
      run: async () => {
        throw new Error("not used");
      },
    });

    await expect(ctx.drivers.skills("skilled", "/project")).resolves.toEqual([
      { name: "verify", invocation: "/", description: "Prove the change works" },
    ]);
    expect(calls).toEqual(["/project"]);
    expect(() => ctx.drivers.skills("missing", "/project")).toThrow(
      'driver "missing" is not registered',
    );
  });

  it("serves provider skills from the current project root", async () => {
    const app = new App();
    const ctx = app.rootCtx;
    ctx.plugin(HttpRoutes);
    ctx.plugin(SessionDrivers);
    ctx.plugin((owner) => {
      owner.provide("store", { rootPath: "/current/project" } as never);
    });
    ctx.plugin(driverRoutes);
    await app.settle();
    ctx.drivers.register(ctx, {
      id: "skilled",
      skills: async (workdir) => [
        { name: "root", invocation: "/", description: `Works in ${workdir}` },
      ],
      run: async () => {
        throw new Error("not used");
      },
    });

    const match = ctx.routes.match("GET", "/api/skills");
    expect(match).toBeDefined();
    await expect(
      match!.route.handle({
        method: "GET",
        path: "/api/skills",
        params: {},
        query: { driver: "skilled" },
        headers: {},
        body: undefined,
      }),
    ).resolves.toEqual([
      {
        name: "root",
        invocation: "/",
        description: "Works in /current/project",
      },
    ]);
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

describe("reasoning effort", () => {
  /**
   * The minimum input a driver's validation path needs. Events are collected
   * so a test can assert a rejection happened *before* anything was journaled
   * — the property the validate-first comments in both adapters promise.
   */
  function makeRunInput(overrides: Partial<DriverRunInput> = {}) {
    const events: unknown[] = [];
    const input: DriverRunInput = {
      sessionId: SessionId("s_effort"),
      workdir: "/tmp/project",
      context: [],
      task: "do the thing",
      modelId: null,
      effort: null,
      fastMode: false,
      tools: [],
      onEvent: (event) => events.push(event),
      drainInjections: () => [],
      resolveImage: () => {
        throw new Error("no blobs in this test");
      },
      signal: new AbortController().signal,
      permissionMode: "auto",
      ...overrides,
    };
    return { input, events };
  }

  it("claude rejects a level outside the SDK union before any event or spawn", async () => {
    const driver = new ClaudeDriver("claude");
    const { input, events } = makeRunInput({ effort: "turbo" });
    await expect(driver.run(input)).rejects.toThrow(/unknown effort "turbo"/);
    expect(events).toEqual([]);
  });

  it("codex rejects a level outside the SDK union before any event or spawn", async () => {
    const driver = new CodexDriver("codex");
    const { input, events } = makeRunInput({ effort: "hyper" });
    await expect(driver.run(input)).rejects.toThrow(/unknown effort "hyper"/);
    expect(events).toEqual([]);
  });

  it("bakes per-model effort levels into the claude catalog", () => {
    const models = new ClaudeDriver("claude").models;
    const byId = new Map(models.map((m) => [m.id, m.efforts]));
    // Current generation carries the full union...
    expect(byId.get("claude-opus-5")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    // ...the 4.6 generation predates xhigh...
    expect(byId.get("claude-opus-4-6")).not.toContain("xhigh");
    expect(byId.get("claude-sonnet-4-6")).not.toContain("xhigh");
    // ...and haiku rejects the parameter outright, so it offers none.
    expect(byId.get("claude-haiku-4-5")).toBeUndefined();
  });

  it("keeps efforts through the config layer instead of stripping them", async () => {
    // The list-item schema validates-and-strips: a key missing from the
    // config shape would vanish from the catalog even when present in the
    // baked-in default. This pins that `efforts` is declared in the shape.
    const app = new App();
    const ctx = app.rootCtx;
    ctx.plugin(SessionDrivers);
    ctx.plugin(claudePlugin);
    ctx.plugin(codexPlugin, {
      id: "codex",
      models: [{ id: "custom-1", label: "Custom One", efforts: ["low", "high"] }],
    });
    await app.settle();

    const catalog = ctx.drivers.catalog();
    const claude = catalog.find((entry) => entry.driver === "claude");
    const opus = claude?.models.find((m) => m.id === "claude-opus-5");
    expect(opus?.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    const codex = catalog.find((entry) => entry.driver === "codex");
    expect(codex?.models[0]?.efforts).toEqual(["low", "high"]);
  });
});

describe("Codex runtime error payloads", () => {
  it("treats a nullable MCP error as absent", () => {
    expect(codexErrorMessage(null)).toBeUndefined();
    expect(codexErrorMessage(undefined)).toBeUndefined();
  });

  it("preserves object and string error messages", () => {
    expect(codexErrorMessage({ message: "browser failed" })).toBe("browser failed");
    expect(codexErrorMessage("transport failed")).toBe("transport failed");
  });

  it("ignores malformed error payloads", () => {
    expect(codexErrorMessage({ message: null })).toBeUndefined();
    expect(codexErrorMessage({ message: 500 })).toBeUndefined();
  });

  it("maps the shared fast flag to each provider's native setting", () => {
    expect(claudeFastSettings(true)).toEqual({
      fastMode: true,
      fastModePerSessionOptIn: true,
    });
    expect(claudeFastSettings(false)).toEqual({
      fastMode: false,
      fastModePerSessionOptIn: true,
    });
    expect(codexServiceTier(true)).toBe("fast");
    expect(codexServiceTier(false)).toBe("default");
  });
});
