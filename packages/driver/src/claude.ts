import { z } from "zod";
import { defineConfig, field } from "@daydream-code/config";
import {
  createSdkMcpServer,
  query,
  tool,
  type EffortLevel,
  type Options,
  type SDKUserMessage,
  type SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";
import type { Context } from "@daydream-code/kernel";
import { zeroUsage, type ImagePart, type Usage } from "@daydream-code/shared";
import type { HarnessToolDefinition } from "@daydream-code/tools";
import {
  DriverModelSchema,
  type DriverModel,
  type DriverRunInput,
  type DriverSessionResult,
  type AgentSkill,
  type SessionDriver,
} from "./index.js";
import { injectedPayload } from "./index.js";
import { onAbort, signalAborted, triggerAbort } from "./abort.js";
import { renderInitialPrompt } from "./prompt.js";

export { renderInitialPrompt } from "./prompt.js";

// ---------------------------------------------------------------------------
// JSON Schema -> zod raw shape.
//
// Recursive: arrays carry their item type and objects their inner shape, so a
// nested schema (the `ask_user` array of questions, each with an array of
// options) reaches the model as structure rather than as `unknown`. The old
// one-level version silently flattened anything nested, which reads as a
// working tool right up until the model has to guess the argument shape.
//
// Structural only — JSON Schema bounds like minItems are not translated, so a
// tool with real bounds still validates its own arguments.

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
    case "array":
      type = z.array(
        p.items !== null && typeof p.items === "object"
          ? propToZod(p.items)
          : z.unknown(),
      );
      break;
    case "object":
      type =
        p.properties !== null && typeof p.properties === "object"
          ? z.object(jsonSchemaToZodShape(p))
          : z.looseObject({});
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

/** A text block plus one block per image, in the shape the SDK accepts. */
type ContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    };

function userMessage(text: string, blocks: ContentBlock[] = []): SDKUserMessage {
  // Plain string when there is nothing to attach: the SDK is happiest with
  // its simplest form, and this keeps existing transcripts byte-identical.
  //
  // An image with no caption is a real message — you paste a screenshot and
  // press send — but an empty text block beside it is rejected by the API, so
  // the block is dropped rather than sent blank.
  const content =
    blocks.length === 0
      ? text
      : ([
          ...(text.length > 0 ? [{ type: "text", text }] : []),
          ...blocks,
        ] as ContentBlock[]);
  return {
    type: "user",
    message: {
      role: "user",
      content: content as SDKUserMessage["message"]["content"],
    },
    parent_tool_use_id: null,
  };
}

/** Map attached images to base64 blocks, skipping any the store lost. */
function imageBlocks(
  images: readonly ImagePart[] | undefined,
  input: DriverRunInput,
): ContentBlock[] {
  if (images === undefined || images.length === 0) return [];
  const blocks: ContentBlock[] = [];
  for (const image of images) {
    try {
      const resolved = input.resolveImage(image);
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: resolved.mediaType,
          data: resolved.base64(),
        },
      });
    } catch (error) {
      // A missing blob must not kill a turn — the prompt preamble still
      // carries an `[image]` placeholder, so the model knows one was meant.
      input.onEvent({
        type: "driver_error",
        payload: { error: `image ${image.blobId} unavailable: ${String(error)}` },
      });
    }
  }
  return blocks;
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

/**
 * The levels the Agent SDK accepts, typed against its union so a rename in
 * the SDK breaks the build here rather than a session at runtime.
 */
const CLAUDE_EFFORTS: readonly EffortLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Narrow a stored effort string to the SDK's union, loudly. */
function claudeEffort(level: string): EffortLevel {
  if (!(CLAUDE_EFFORTS as readonly string[]).includes(level)) {
    throw new Error(
      `unknown effort "${level}" — claude accepts ${CLAUDE_EFFORTS.join(", ")}`,
    );
  }
  return level as EffortLevel;
}

/** Session-scoped SDK settings for Daydream's explicit fast-mode choice. */
export function claudeFastSettings(fastMode: boolean): {
  fastMode: boolean;
  fastModePerSessionOptIn: true;
} {
  return { fastMode, fastModePerSessionOptIn: true };
}

/**
 * Baked-in catalog (config-replaceable). No `isDefault`: an unset modelId
 * defers to the user's own Claude Code default model.
 *
 * `efforts` per model rather than per driver: the 4.6 generation predates
 * `xhigh`, and Haiku 4.5 rejects the effort parameter outright, so its list
 * is absent and the picker offers nothing. The SDK silently downgrades a
 * level the selected model lacks, so an over-claim here degrades rather than
 * errors — but the catalog should still not offer what cannot run.
 */
const CLAUDE_MODELS: DriverModel[] = [
  { id: "claude-fable-5", label: "Claude Fable 5", description: "most capable, Mythos-class", efforts: [...CLAUDE_EFFORTS] },
  { id: "claude-opus-5", label: "Claude Opus 5", efforts: [...CLAUDE_EFFORTS] },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8", efforts: [...CLAUDE_EFFORTS] },
  { id: "claude-opus-4-7", label: "Claude Opus 4.7", efforts: [...CLAUDE_EFFORTS] },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6", efforts: ["low", "medium", "high", "max"] },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", efforts: [...CLAUDE_EFFORTS] },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", efforts: ["low", "medium", "high", "max"] },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", description: "fast and cheap" },
];

export class ClaudeDriver implements SessionDriver {
  readonly supportsFastMode = true;

  constructor(
    readonly id: string,
    readonly models: readonly DriverModel[] = CLAUDE_MODELS,
  ) {}

  async skills(workdir: string): Promise<AgentSkill[]> {
    // A prompt that never produces a turn lets the SDK initialise its native
    // skill registry without spending a model call. `return()` below closes
    // the subprocess as soon as the control response arrives.
    const idlePrompt: AsyncIterable<SDKUserMessage> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<SDKUserMessage>>(() => undefined),
        };
      },
    };
    const session = query({ prompt: idlePrompt, options: { cwd: workdir } });
    try {
      const response = await session.reloadSkills();
      return response.skills.map(claudeSkill);
    } finally {
      await session.return();
    }
  }

  async run(input: DriverRunInput): Promise<DriverSessionResult> {
    // Validated before anything is journaled or spawned: a bad level should
    // fail the dispatch, not a turn that already cost tokens.
    const effort = input.effort !== null ? claudeEffort(input.effort) : null;
    const prompt = new AsyncPushQueue<SDKUserMessage>();
    prompt.push(
      userMessage(
        renderInitialPrompt(input.context, input.task, input.transcript ?? []),
        imageBlocks(input.taskImages, input),
      ),
    );

    const controller = new AbortController();
    const offAbort = onAbort(input.signal, () => triggerAbort(controller));

    const options: Options = {
      cwd: input.workdir,
      abortController: controller,
      mcpServers: { daydream: harnessMcpServer(input) },
      // Keep speed a Daydream session choice rather than inheriting a
      // machine-wide Claude Code preference. The per-session opt-in prevents
      // the SDK from carrying an interactive toggle into a later run.
      settings: claudeFastSettings(input.fastMode),
      ...(input.modelId !== null ? { model: input.modelId } : {}),
      ...(effort !== null ? { effort } : {}),
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
              fast_mode_state: message.fast_mode_state ?? "off",
              ...(message.fast_mode_disabled_reason !== undefined
                ? { fast_mode_disabled_reason: message.fast_mode_disabled_reason }
                : {}),
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
                payload: injectedPayload(injection),
              });
            }
            // Batch into one user message; [master thread update] blocks
            // arrive already formatted and are passed through verbatim.
            prompt.push(
              userMessage(
                injections.map((i) => i.text).join("\n\n"),
                injections.flatMap((i) => imageBlocks(i.images, input)),
              ),
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

/** Claude appends a source label for display; scope is not a separate field. */
function claudeSkill(skill: SlashCommand): AgentSkill {
  const description = skill.description.replace(
    /\s+\((?:user|project|local|plugin|policy)\)$/,
    "",
  );
  return {
    name: skill.name,
    invocation: "/",
    description,
    ...(skill.argumentHint.length > 0 ? { argumentHint: skill.argumentHint } : {}),
  };
}

export const name = "driver-claude";
export const inject = ["drivers"] as const;

export const { Config, settings } = defineConfig({
  id: field.string({
    label: "driver id",
    help: "how sessions name this driver. Changing it orphans sessions that pinned the old name.",
    default: "claude",
    advanced: true,
  }),
  models: field.list({
    label: "model catalog",
    help: "what the model picker offers. Removing one does not stop a session that already pinned it.",
    item: {
      id: field.string({ label: "model id", placeholder: "claude_models" }),
      label: field.string({ label: "shown as" }),
      description: field.string({ label: "description", optional: true }),
      isDefault: field.boolean({ label: "preselected", optional: true }),
      // Declared here or it is stripped: the list item validates-and-strips,
      // so a key missing from this shape never reaches the catalog — not even
      // from the baked-in default above.
      efforts: field.json({
        label: "effort levels",
        help: "reasoning-effort levels the picker offers for this model. Omit for none.",
        schema: z.array(z.string()),
        optional: true,
      }),
    },
    default: CLAUDE_MODELS,
  }),
});

export function apply(ctx: Context, config: z.infer<typeof Config>): void {
  ctx.drivers.register(ctx, new ClaudeDriver(config.id, config.models));
}

export default { name, inject, Config, settings, apply };
