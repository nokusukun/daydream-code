import { z } from "zod";
import {
  createSdkMcpServer,
  query,
  tool,
  type Options,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Context } from "@daydream-code/kernel";
import { zeroUsage, type Usage } from "@daydream-code/shared";
import type { HarnessToolDefinition } from "@daydream-code/tools";
import type {
  DriverRunInput,
  DriverSessionResult,
  SessionDriver,
} from "./index.js";
import { onAbort, signalAborted, triggerAbort } from "./abort.js";
import { renderInitialPrompt } from "./prompt.js";

export { renderInitialPrompt } from "./prompt.js";

// ---------------------------------------------------------------------------
// JSON Schema -> zod raw shape (covers the harness-tool schemas: object with
// string/number/boolean/array-of-string props + required)

function propToZod(prop: unknown): z.ZodType {
  const p =
    prop !== null && typeof prop === "object"
      ? (prop as Record<string, unknown>)
      : {};
  let type: z.ZodType;
  switch (p.type) {
    case "string":
      type = z.string();
      break;
    case "number":
    case "integer":
      type = z.number();
      break;
    case "boolean":
      type = z.boolean();
      break;
    case "array": {
      const items =
        p.items !== null && typeof p.items === "object"
          ? (p.items as Record<string, unknown>)
          : {};
      type = items.type === "string" ? z.array(z.string()) : z.array(z.unknown());
      break;
    }
    case "object":
      type = z.looseObject({});
      break;
    default:
      type = z.unknown();
  }
  if (typeof p.description === "string") type = type.describe(p.description);
  return type;
}

/**
 * Convert a JSON Schema object into a zod v4 raw shape for the SDK's `tool()`.
 * Non-object schemas fall back to an empty (open) shape.
 */
export function jsonSchemaToZodShape(
  schema: Record<string, unknown>,
): Record<string, z.ZodType> {
  if (
    schema.type !== "object" ||
    schema.properties === null ||
    typeof schema.properties !== "object"
  ) {
    return {};
  }
  const required = new Set(
    Array.isArray(schema.required) ? (schema.required as string[]) : [],
  );
  const shape: Record<string, z.ZodType> = {};
  for (const [key, prop] of Object.entries(
    schema.properties as Record<string, unknown>,
  )) {
    const base = propToZod(prop);
    shape[key] = required.has(key) ? base : base.optional();
  }
  return shape;
}

// ---------------------------------------------------------------------------
// Streaming-input queue: the prompt AsyncIterable the run loop pushes into.

class AsyncPushQueue<T> implements AsyncIterable<T> {
  #values: T[] = [];
  #waiters: Array<(result: IteratorResult<T>) => void> = [];
  #closed = false;

  push(value: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.#values.push(value);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.#values.length > 0) {
          return Promise.resolve({ value: this.#values.shift()!, done: false });
        }
        if (this.#closed) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

function userMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  };
}

function permissionOptions(mode: DriverRunInput["permissionMode"]): Options {
  switch (mode) {
    case "auto":
      return {
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
      };
    case "ask":
      return { permissionMode: "default" };
    case "readonly":
      return { permissionMode: "plan" };
  }
}

function harnessMcpServer(input: DriverRunInput) {
  return createSdkMcpServer({
    name: "daydream",
    tools: input.tools.map((definition: HarnessToolDefinition) =>
      tool(
        definition.name,
        definition.description,
        jsonSchemaToZodShape(definition.parameters),
        async (args: Record<string, unknown>) => {
          try {
            const result = await definition.execute(args, {
              sessionId: input.sessionId,
              projectRoot: input.workdir,
            });
            return {
              content: [
                { type: "text" as const, text: JSON.stringify(result ?? null) },
              ],
            };
          } catch (error) {
            return {
              content: [{ type: "text" as const, text: String(error) }],
              isError: true,
            };
          }
        },
      ),
    ),
  });
}

// ---------------------------------------------------------------------------
// Driver

export class ClaudeDriver implements SessionDriver {
  constructor(readonly id: string) {}

  async run(input: DriverRunInput): Promise<DriverSessionResult> {
    const prompt = new AsyncPushQueue<SDKUserMessage>();
    prompt.push(userMessage(renderInitialPrompt(input.context, input.task)));

    const controller = new AbortController();
    const offAbort = onAbort(input.signal, () => triggerAbort(controller));

    const options: Options = {
      cwd: input.workdir,
      abortController: controller,
      mcpServers: { daydream: harnessMcpServer(input) },
      ...(input.modelId !== null ? { model: input.modelId } : {}),
      ...(input.resumeToken != null ? { resume: input.resumeToken } : {}),
      ...permissionOptions(input.permissionMode),
    };

    let resumeToken: string | undefined =
      input.resumeToken != null ? input.resumeToken : undefined;
    let usage: Usage = zeroUsage();
    let resultText: string | undefined;
    let lastAssistantText = "";

    const buildResult = (): DriverSessionResult => {
      const summary = resultText ?? lastAssistantText;
      return {
        summary,
        tldr: summary.slice(0, 120),
        usage,
        ...(resumeToken !== undefined ? { resumeToken } : {}),
      };
    };

    try {
      for await (const message of query({ prompt, options })) {
        if (message.type === "system" && message.subtype === "init") {
          resumeToken = message.session_id;
          input.onEvent({
            type: "context_assembled",
            payload: {
              model: message.model,
              tools: message.tools,
              session_id: message.session_id,
              cwd: message.cwd,
            },
          });
        } else if (message.type === "assistant") {
          for (const block of message.message.content) {
            if (block.type === "text") {
              lastAssistantText = block.text;
              input.onEvent({ type: "turn", payload: { text: block.text } });
            } else if (block.type === "thinking") {
              input.onEvent({
                type: "thinking",
                payload: { text: block.thinking },
              });
            } else if (block.type === "tool_use") {
              input.onEvent({
                type: "tool_call",
                payload: { id: block.id, name: block.name, args: block.input },
              });
            }
          }
        } else if (message.type === "user") {
          const content = message.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "tool_result") {
                input.onEvent({
                  type: "tool_result",
                  payload: {
                    toolCallId: block.tool_use_id,
                    result: block.content ?? null,
                    ...(block.is_error !== undefined
                      ? { isError: block.is_error }
                      : {}),
                  },
                });
              }
            }
          }
        } else if (message.type === "result") {
          // total_cost_usd / modelUsage are cumulative across turns in
          // streaming-input sessions: read the latest result, emit the delta.
          let tokensIn = 0;
          let tokensOut = 0;
          for (const modelUsage of Object.values(message.modelUsage)) {
            tokensIn += modelUsage.inputTokens;
            tokensOut += modelUsage.outputTokens;
          }
          const cumulative = {
            tokensIn,
            tokensOut,
            costUsd: message.total_cost_usd,
          };
          const delta = {
            tokensIn: Math.max(0, cumulative.tokensIn - usage.tokensIn),
            tokensOut: Math.max(0, cumulative.tokensOut - usage.tokensOut),
            costUsd: Math.max(0, cumulative.costUsd - usage.costUsd),
          };
          usage = cumulative;
          if (message.subtype === "success") resultText = message.result;
          input.onEvent({
            type: "turn_end",
            payload: { reason: message.subtype },
            usage: delta,
          });

          const injections = input.drainInjections();
          if (injections.length > 0 && !signalAborted(input.signal)) {
            for (const injection of injections) {
              input.onEvent({
                type: "user_injected",
                payload: { kind: injection.kind, text: injection.text },
              });
            }
            // Batch into one user message; [master thread update] blocks
            // arrive already formatted and are passed through verbatim.
            prompt.push(
              userMessage(injections.map((i) => i.text).join("\n\n")),
            );
          } else {
            prompt.close();
          }
        }
      }
    } catch (error) {
      if (signalAborted(input.signal)) return buildResult();
      input.onEvent({ type: "driver_error", payload: { error: String(error) } });
      throw error;
    } finally {
      prompt.close();
      offAbort();
    }

    return buildResult();
  }
}

export const name = "driver-claude";
export const inject = ["drivers"] as const;

export const Config = z
  .object({ id: z.string().default("claude") })
  .prefault({});

export function apply(ctx: Context, config: z.infer<typeof Config>): void {
  ctx.drivers.register(ctx, new ClaudeDriver(config.id));
}

export default { name, inject, Config, apply };
