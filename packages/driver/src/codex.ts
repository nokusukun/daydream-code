import { z } from "zod";
import {
  Codex,
  type Thread,
  type ThreadItem,
  type ThreadOptions,
} from "@openai/codex-sdk";
import type { Context } from "@daydream-code/kernel";
import { addUsage, zeroUsage, type Usage } from "@daydream-code/shared";
import type {
  DriverRunInput,
  DriverSessionResult,
  SessionDriver,
} from "./index.js";
import { signalAborted } from "./abort.js";
import { renderInitialPrompt } from "./prompt.js";

function threadOptions(input: DriverRunInput): ThreadOptions {
  const base: ThreadOptions = {
    workingDirectory: input.workdir,
    skipGitRepoCheck: true,
    ...(input.modelId !== null ? { model: input.modelId } : {}),
  };
  switch (input.permissionMode) {
    case "auto":
      return {
        ...base,
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
      };
    case "ask":
      return {
        ...base,
        sandboxMode: "workspace-write",
        approvalPolicy: "on-request",
      };
    case "readonly":
      return { ...base, sandboxMode: "read-only", approvalPolicy: "never" };
  }
}

export class CodexDriver implements SessionDriver {
  constructor(readonly id: string) {}

  async run(input: DriverRunInput): Promise<DriverSessionResult> {
    const codex = new Codex();
    const options = threadOptions(input);
    const thread: Thread =
      input.resumeToken != null
        ? codex.resumeThread(input.resumeToken, options)
        : codex.startThread(options);

    // The Codex SDK offers no custom-tool surface, so harness tools cannot be
    // exposed. Journal that fact rather than faking it.
    input.onEvent({
      type: "context_assembled",
      payload: {
        driver: this.id,
        ...(input.modelId !== null ? { model: input.modelId } : {}),
        harnessTools: "unavailable",
      },
    });

    let resumeToken: string | undefined =
      input.resumeToken != null ? input.resumeToken : undefined;
    let usage: Usage = zeroUsage();
    let finalResponse = "";

    const emitItem = (item: ThreadItem): void => {
      switch (item.type) {
        case "agent_message":
          finalResponse = item.text;
          input.onEvent({ type: "turn", payload: { text: item.text } });
          break;
        case "reasoning":
          input.onEvent({ type: "thinking", payload: { text: item.text } });
          break;
        case "command_execution":
          input.onEvent({
            type: "tool_call",
            payload: { id: item.id, name: "command", command: item.command },
          });
          input.onEvent({
            type: "tool_result",
            payload: {
              id: item.id,
              name: "command",
              output: item.aggregated_output,
              status: item.status,
              ...(item.exit_code !== undefined
                ? { exitCode: item.exit_code }
                : {}),
            },
          });
          break;
        case "file_change":
          input.onEvent({
            type: "tool_call",
            payload: {
              id: item.id,
              name: "file_change",
              changes: item.changes,
              status: item.status,
            },
          });
          break;
        case "mcp_tool_call":
          input.onEvent({
            type: "tool_call",
            payload: {
              id: item.id,
              server: item.server,
              name: item.tool,
              args: item.arguments ?? null,
            },
          });
          input.onEvent({
            type: "tool_result",
            payload: {
              id: item.id,
              server: item.server,
              name: item.tool,
              status: item.status,
              ...(item.result !== undefined ? { result: item.result } : {}),
              ...(item.error !== undefined
                ? { error: item.error.message }
                : {}),
            },
          });
          break;
        case "error":
          input.onEvent({
            type: "driver_error",
            payload: { error: item.message },
          });
          break;
        default:
          // web_search, todo_list, future item types: not journal-worthy yet.
          break;
      }
    };

    const runTurn = async (text: string): Promise<void> => {
      const { events } = await thread.runStreamed(text, {
        signal: input.signal,
      });
      for await (const event of events) {
        switch (event.type) {
          case "thread.started":
            resumeToken = event.thread_id;
            break;
          case "item.completed":
            emitItem(event.item);
            break;
          case "turn.completed": {
            const turnUsage = {
              tokensIn:
                event.usage.input_tokens + event.usage.cached_input_tokens,
              tokensOut: event.usage.output_tokens,
            };
            usage = addUsage(usage, turnUsage);
            input.onEvent({
              type: "turn_end",
              payload: { reason: "completed" },
              usage: turnUsage,
            });
            break;
          }
          case "turn.failed":
            input.onEvent({
              type: "turn_end",
              payload: { reason: "failed" },
            });
            throw new Error(event.error.message);
          case "error":
            throw new Error(event.message);
          default:
            break;
        }
      }
      if (thread.id !== null) resumeToken = thread.id;
    };

    const buildResult = (): DriverSessionResult => ({
      summary: finalResponse,
      tldr: finalResponse.slice(0, 120),
      usage,
      ...(resumeToken !== undefined ? { resumeToken } : {}),
    });

    try {
      await runTurn(renderInitialPrompt(input.context, input.task));
      // Injection loop: keep running follow-up turns while injections queue up.
      while (!signalAborted(input.signal)) {
        const injections = input.drainInjections();
        if (injections.length === 0) break;
        for (const injection of injections) {
          input.onEvent({
            type: "user_injected",
            payload: { kind: injection.kind, text: injection.text },
          });
        }
        await runTurn(injections.map((i) => i.text).join("\n\n"));
      }
    } catch (error) {
      if (signalAborted(input.signal)) return buildResult();
      input.onEvent({
        type: "driver_error",
        payload: { error: String(error) },
      });
      throw error;
    }

    return buildResult();
  }
}

export const name = "driver-codex";
export const inject = ["drivers"] as const;

export const Config = z
  .object({ id: z.string().default("codex") })
  .prefault({});

export function apply(ctx: Context, config: z.infer<typeof Config>): void {
  ctx.drivers.register(ctx, new CodexDriver(config.id));
}

export default { name, inject, Config, apply };
