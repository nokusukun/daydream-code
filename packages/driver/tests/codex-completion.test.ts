import { describe, expect, it, vi } from "vitest";
import { SessionId } from "@daydream-code/shared";
import type { DriverRunInput } from "@daydream-code/driver";

let iteratorReleased = false;

vi.mock("@openai/codex-sdk", () => {
  const events = {
    [Symbol.asyncIterator]() {
      let next = 0;
      return {
        async next(): Promise<IteratorResult<unknown>> {
          next += 1;
          if (next === 1) {
            return {
              done: false,
              value: { type: "thread.started", thread_id: "thread_done" },
            };
          }
          if (next === 2) {
            return {
              done: false,
              value: {
                type: "item.completed",
                item: { type: "agent_message", id: "answer", text: "finished" },
              },
            };
          }
          if (next === 3) {
            return {
              done: false,
              value: {
                type: "turn.completed",
                usage: {
                  input_tokens: 5,
                  cached_input_tokens: 2,
                  output_tokens: 3,
                },
              },
            };
          }
          // Reproduce the provider transport staying open after its terminal
          // event. The adapter must not await this fourth read.
          return new Promise<IteratorResult<unknown>>(() => undefined);
        },
        async return(): Promise<IteratorResult<unknown>> {
          iteratorReleased = true;
          return { done: true, value: undefined };
        },
      };
    },
  };

  class MockThread {
    readonly id = "thread_done";

    async runStreamed(): Promise<{ events: typeof events }> {
      return { events };
    }
  }

  return {
    Codex: class {
      startThread(): MockThread {
        return new MockThread();
      }

      resumeThread(): MockThread {
        return new MockThread();
      }
    },
  };
});

import { CodexDriver } from "@daydream-code/driver/codex";

describe("Codex terminal event handling", () => {
  it("finishes the session when turn.completed arrives even if the stream stays open", async () => {
    iteratorReleased = false;
    const journal: Array<{ type: string; payload: unknown }> = [];
    const input: DriverRunInput = {
      sessionId: SessionId("ses_codex_completed"),
      workdir: "C:\\project",
      context: [],
      task: "finish the work",
      modelId: null,
      effort: null,
      fastMode: false,
      tools: [],
      onEvent: (event) => journal.push(event),
      drainInjections: () => [],
      resolveImage: () => {
        throw new Error("no images in this test");
      },
      signal: new AbortController().signal,
      permissionMode: "auto",
      resumeToken: null,
    };

    await expect(new CodexDriver("codex").run(input)).resolves.toMatchObject({
      summary: "finished",
      tldr: "finished",
      resumeToken: "thread_done",
      usage: { tokensIn: 7, tokensOut: 3 },
    });
    expect(iteratorReleased).toBe(true);
    expect(journal.filter((event) => event.type === "turn_end")).toHaveLength(1);
  }, 1_000);
});
