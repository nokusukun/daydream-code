import { z } from "zod";
import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { defineConfig, field } from "@daydream-code/config";
import {
  Codex,
  type ModelReasoningEffort,
  type Thread,
  type ThreadItem,
  type ThreadOptions,
  type UserInput,
} from "@openai/codex-sdk";
import type { Context } from "@daydream-code/kernel";
import {
  addUsage,
  zeroUsage,
  type ImagePart,
  type Usage,
} from "@daydream-code/shared";
import {
  DriverModelSchema,
  type AgentSkill,
  type DriverModel,
  type DriverRunInput,
  type DriverSessionResult,
  type SessionDriver,
} from "./index.js";
import { injectedPayload } from "./index.js";
import { signalAborted } from "./abort.js";
import { renderInitialPrompt } from "./prompt.js";

/**
 * The SDK declares one union for every thread rather than a per-model list,
 * so the catalog mirrors it wholesale below. Typed against the union so an
 * SDK rename breaks the build here, not a session at runtime.
 */
const CODEX_EFFORTS: readonly ModelReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];

/**
 * Codex CLI JSON is a runtime boundary. Some successful MCP calls currently
 * include `error: null`, even though the SDK type models the field as an
 * optional object. Keep malformed or nullable error payloads from taking down
 * the whole session while still preserving useful messages when present.
 */
export function codexErrorMessage(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (typeof value !== "object" || value === null) return undefined;
  const message = (value as { message?: unknown }).message;
  return typeof message === "string" && message.length > 0 ? message : undefined;
}

/** Narrow a stored effort string to the SDK's union, loudly. */
function codexEffort(level: string): ModelReasoningEffort {
  if (!(CODEX_EFFORTS as readonly string[]).includes(level)) {
    throw new Error(
      `unknown effort "${level}" — codex accepts ${CODEX_EFFORTS.join(", ")}`,
    );
  }
  return level as ModelReasoningEffort;
}

/** Codex's config sentinel for an explicit fast or standard service tier. */
export function codexServiceTier(fastMode: boolean): "fast" | "default" {
  return fastMode ? "fast" : "default";
}

function threadOptions(input: DriverRunInput): ThreadOptions {
  const base: ThreadOptions = {
    workingDirectory: input.workdir,
    skipGitRepoCheck: true,
    ...(input.modelId !== null ? { model: input.modelId } : {}),
    ...(input.effort !== null
      ? { modelReasoningEffort: codexEffort(input.effort) }
      : {}),
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

/** Baked-in catalog (config-replaceable): the current Codex lineup. */
const CODEX_MODELS: DriverModel[] = [
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", description: "flagship", isDefault: true, efforts: [...CODEX_EFFORTS] },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", description: "everyday workhorse", efforts: [...CODEX_EFFORTS] },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", description: "fast and affordable", efforts: [...CODEX_EFFORTS] },
];

export class CodexDriver implements SessionDriver {
  readonly supportsFastMode = true;

  constructor(
    readonly id: string,
    readonly models: readonly DriverModel[] = CODEX_MODELS,
  ) {}

  skills(workdir: string): Promise<AgentSkill[]> {
    return codexSkills(workdir);
  }

  async run(input: DriverRunInput): Promise<DriverSessionResult> {
    // Explicitly write the standard sentinel when off. Omitting the override
    // would inherit a user's global `service_tier = "fast"` and make the
    // session toggle lie about the speed actually requested.
    const codex = new Codex({
      config: { service_tier: codexServiceTier(input.fastMode) },
    });
    // May throw on a bad effort level — before any thread exists, so the
    // dispatch fails rather than a turn that already cost tokens.
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
        case "mcp_tool_call": {
          const error = codexErrorMessage(item.error);
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
              ...(error !== undefined ? { error } : {}),
            },
          });
          break;
        }
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

    /**
     * Codex takes images only as `{ type: "local_image", path }` — there is no
     * base64 or URL form — so the blob store keeps real files inside the
     * project, where the sandbox modes can read them.
     */
    const turnInput = (
      text: string,
      images: readonly ImagePart[] | undefined,
    ): string | UserInput[] => {
      if (images === undefined || images.length === 0) return text;
      // Same rule as the Claude driver: a captionless image is a message, an
      // empty text part beside it is not.
      const parts: UserInput[] = text.length > 0 ? [{ type: "text", text }] : [];
      for (const image of images) {
        try {
          parts.push({ type: "local_image", path: input.resolveImage(image).path });
        } catch (error) {
          input.onEvent({
            type: "driver_error",
            payload: {
              error: `image ${image.blobId} unavailable: ${String(error)}`,
            },
          });
        }
      }
      return parts;
    };

    const runTurn = async (
      text: string,
      images?: readonly ImagePart[],
    ): Promise<void> => {
      const { events } = await thread.runStreamed(turnInput(text, images), {
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
            // `turn.completed` is the provider's terminal contract. Do not
            // wait for the transport iterator to close as well: a Codex
            // subprocess can keep that stream open after its final event,
            // which otherwise leaves the durable session row `running`
            // forever. Returning from a for-await loop also calls the
            // iterator's `return()`, so the SDK still gets a clean teardown.
            if (thread.id !== null) resumeToken = thread.id;
            return;
          }
          case "turn.failed":
            input.onEvent({
              type: "turn_end",
              payload: { reason: "failed" },
            });
            throw new Error(codexErrorMessage(event.error) ?? "Codex turn failed");
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
      await runTurn(
        renderInitialPrompt(input.context, input.task, input.transcript ?? []),
        input.taskImages,
      );
      // Injection loop: keep running follow-up turns while injections queue up.
      while (!signalAborted(input.signal)) {
        const injections = input.drainInjections();
        if (injections.length === 0) break;
        for (const injection of injections) {
          input.onEvent({
            type: "user_injected",
            payload: injectedPayload(injection),
          });
        }
        await runTurn(
          injections.map((i) => i.text).join("\n\n"),
          injections.flatMap((i) => i.images ?? []),
        );
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

interface CodexSkillMetadata {
  name: string;
  description: string;
  shortDescription?: string;
  scope: "user" | "repo" | "system" | "admin";
  enabled: boolean;
}

interface CodexSkillsResponse {
  data: Array<{ cwd: string; skills: CodexSkillMetadata[] }>;
}

interface CodexExecutable {
  executablePath: string;
  pathDirs: string[];
}

/**
 * The SDK resolves a bundled, platform-specific CLI but does not expose its
 * path publicly. Its runtime object retains the resolved executable for turn
 * spawning; reading that value keeps discovery on the exact same Codex build
 * as the agent instead of hoping a different `codex` happens to be on PATH.
 */
function codexExecutable(): CodexExecutable {
  const instance = new Codex() as unknown as {
    exec?: { executablePath?: unknown; pathDirs?: unknown };
  };
  const executablePath = instance.exec?.executablePath;
  const pathDirs = instance.exec?.pathDirs;
  if (
    typeof executablePath !== "string" ||
    !Array.isArray(pathDirs) ||
    !pathDirs.every((item) => typeof item === "string")
  ) {
    throw new Error("the Codex SDK did not expose its resolved executable");
  }
  return { executablePath, pathDirs } as CodexExecutable;
}

/** Query Codex's native registry. No thread or model turn is created. */
export function codexSkills(workdir: string): Promise<AgentSkill[]> {
  const executable = codexExecutable();
  const env = { ...process.env };
  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  env[pathKey] = [
    ...executable.pathDirs,
    env[pathKey] ?? env.PATH ?? "",
  ]
    .filter(Boolean)
    .join(path.delimiter);
  const child = spawn(
    executable.executablePath,
    ["app-server", "--listen", "stdio://"],
    { cwd: workdir, env, stdio: ["pipe", "pipe", "pipe"] },
  );

  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout });
    let stderr = "";
    let settled = false;
    const timer = setTimeout(
      () => finish(new Error("Codex skill discovery timed out")),
      10_000,
    );

    const send = (value: unknown): void => {
      child.stdin.write(`${JSON.stringify(value)}\n`);
    };
    const finish = (error?: Error, skills?: AgentSkill[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.kill();
      if (error !== undefined) reject(error);
      else resolve(skills ?? []);
    };

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => {
      if (!settled) {
        finish(
          new Error(
            `Codex skill discovery exited ${code ?? "early"}${stderr.trim().length > 0 ? `: ${stderr.trim()}` : ""}`,
          ),
        );
      }
    });
    lines.on("line", (line) => {
      if (line.trim().length === 0) return;
      let message: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        return;
      }
      if (message.id === 1) {
        if (message.error != null) {
          finish(new Error(codexErrorMessage(message.error) ?? "Codex could not initialise"));
          return;
        }
        send({ method: "initialized" });
        send({
          id: 2,
          method: "skills/list",
          params: { cwds: [workdir], forceReload: false },
        });
        return;
      }
      if (message.id !== 2) return;
      if (message.error != null) {
        finish(new Error(codexErrorMessage(message.error) ?? "Codex could not list skills"));
        return;
      }
      const response = message.result as CodexSkillsResponse | undefined;
      if (response === undefined || !Array.isArray(response.data)) {
        finish(new Error("Codex returned an invalid skill catalog"));
        return;
      }
      const skills = response.data
        .flatMap((entry) => entry.skills)
        .filter((skill) => skill.enabled)
        .map(
          (skill): AgentSkill => ({
            name: skill.name,
            invocation: "$",
            description: skill.shortDescription ?? skill.description,
            scope: skill.scope,
          }),
        );
      finish(undefined, skills);
    });

    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: "daydream-code",
          title: "Daydream Code",
          version: "0.1.0",
        },
        capabilities: { experimentalApi: true, requestAttestation: false },
      },
    });
  });
}

export const name = "driver-codex";
export const inject = ["drivers"] as const;

export const { Config, settings } = defineConfig({
  id: field.string({
    label: "driver id",
    help: "how sessions name this driver. Changing it orphans sessions that pinned the old name.",
    default: "codex",
    advanced: true,
  }),
  models: field.list({
    label: "model catalog",
    help: "what the model picker offers. Removing one does not stop a session that already pinned it.",
    item: {
      id: field.string({ label: "model id", placeholder: "codex_models" }),
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
    default: CODEX_MODELS,
  }),
});

export function apply(ctx: Context, config: z.infer<typeof Config>): void {
  ctx.drivers.register(ctx, new CodexDriver(config.id, config.models));
}

export default { name, inject, Config, settings, apply };
