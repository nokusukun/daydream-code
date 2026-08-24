import { z } from "zod";
import { defineConfig, field } from "@daydream-code/config";
import type { Context } from "@daydream-code/kernel";
import { signalAborted } from "./abort.js";
import type {
  DriverRunInput,
  DriverSessionResult,
  SessionDriver,
} from "./index.js";

/**
 * Scripted driver for tests: deterministically replays a configured script of
 * turns and harness-tool calls through the journal sink, draining injections
 * at every turn boundary. This is the test harness for the whole system.
 */

const TurnStep = z.object({ turn: z.string() });
const ToolStep = z.object({ tool: z.string(), args: z.any().optional() });
const Step = z.union([TurnStep, ToolStep]);

export type MockStep = z.infer<typeof Step>;

export const { Config, settings } = defineConfig({
  id: field.string({
    label: "driver id",
    help: "how sessions name this driver.",
    default: "mock",
  }),
  script: field.json({
    label: "script",
    help: "the canned steps this driver replays. Used by tests; there is no useful way to author it in a form.",
    schema: z.array(Step),
    default: [] as MockStep[],
    advanced: true,
  }),
});

export type MockConfig = z.infer<typeof Config>;

export class MockDriver implements SessionDriver {
  constructor(
    readonly id: string,
    readonly script: readonly MockStep[],
  ) {}

  async run(input: DriverRunInput): Promise<DriverSessionResult> {
    const turnTexts: string[] = [];

    /**
     * Record what actually arrived, resolved through the runner's blob
     * resolver. Real drivers hand these to their SDK; journaling them is how
     * the end-to-end tests prove an attachment survived the whole path.
     */
    const noteImages = (images: DriverRunInput["taskImages"]): void => {
      if (images === undefined || images.length === 0) return;
      input.onEvent({
        type: "images_attached",
        payload: {
          images: images.map((image) => {
            const resolved = input.resolveImage(image);
            return {
              blobId: image.blobId,
              mediaType: resolved.mediaType,
              alt: image.alt ?? null,
              width: image.width ?? null,
              height: image.height ?? null,
              path: resolved.path,
              base64Bytes: resolved.base64().length,
            };
          }),
        },
      });
    };

    noteImages(input.taskImages);

    const drain = (): number => {
      const injections = input.drainInjections();
      for (const injection of injections) {
        input.onEvent({
          type: "user_injected",
          payload: { kind: injection.kind, text: injection.text },
        });
        noteImages(injection.images);
        const reply = `ack: ${injection.text}`;
        input.onEvent({ type: "turn", payload: { text: reply } });
        input.onEvent({ type: "turn_end", payload: { reason: "end_turn" } });
        turnTexts.push(reply);
      }
      return injections.length;
    };

    for (const step of this.script) {
      if (signalAborted(input.signal)) break;
      if ("turn" in step) {
        input.onEvent({ type: "turn", payload: { text: step.turn } });
        input.onEvent({ type: "turn_end", payload: { reason: "end_turn" } });
        turnTexts.push(step.turn);
      } else {
        const tool = input.tools.find((t) => t.name === step.tool);
        input.onEvent({
          type: "tool_call",
          payload: { name: step.tool, args: step.args ?? null },
        });
        if (!tool) {
          input.onEvent({
            type: "tool_error",
            payload: { name: step.tool, error: `unknown tool "${step.tool}"` },
          });
        } else {
          try {
            const result = await tool.execute(step.args, {
              sessionId: input.sessionId,
              projectRoot: input.workdir,
            });
            input.onEvent({
              type: "tool_result",
              payload: { name: step.tool, result: result ?? null },
            });
          } catch (error) {
            input.onEvent({
              type: "tool_error",
              payload: { name: step.tool, error: String(error) },
            });
          }
        }
      }
      // Turn boundary: feed queued injections into the "next turn".
      drain();
    }

    // Final turn boundary: keep draining until the queue stays empty (an
    // ack turn is itself a boundary that may enqueue follow-ups).
    while (!signalAborted(input.signal) && drain() > 0) {
      // drained in condition
    }

    return {
      summary: `mock summary: ${turnTexts.join(" | ")}`,
      tldr: "mock tldr",
      usage: { tokensIn: 10, tokensOut: 5, costUsd: 0 },
    };
  }
}

export const name = "driver-mock";
export const inject = ["drivers"] as const;

export function apply(ctx: Context, config: MockConfig): void {
  ctx.drivers.register(ctx, new MockDriver(config.id, config.script));
}

export default { name, inject, Config, settings, apply };
