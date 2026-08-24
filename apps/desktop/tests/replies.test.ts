import { describe, expect, it } from "vitest";
import { SessionId, type JournalEvent } from "@daydream-code/shared";
import {
  absorb,
  activityOf,
  plain,
  type Activity,
} from "../src/replies.js";

function event(
  id: number,
  session: string,
  type: string,
  payload: unknown,
): JournalEvent {
  return {
    id,
    sessionId: SessionId(session),
    type,
    ts: `2026-08-24T10:00:${String(id).padStart(2, "0")}.000Z`,
    payload,
  };
}

describe("activityOf", () => {
  it("turns assistant prose into a reply preview", () => {
    expect(activityOf(event(1, "s_a", "turn", { text: "**Done.**\nTests pass." }))).toMatchObject({
      kind: "reply",
      label: "reply",
      text: "Done. Tests pass.",
    });
  });

  it("shows a tool call by name and its useful collapsed preview", () => {
    expect(
      activityOf(
        event(2, "s_a", "tool_call", {
          name: "Bash",
          args: { command: "pnpm test\npnpm build" },
        }),
      ),
    ).toMatchObject({
      kind: "tool",
      label: "Bash",
      text: "pnpm test +1 line",
    });
  });

  it("surfaces questions, sibling messages and failures with semantic labels", () => {
    expect(
      activityOf(
        event(3, "s_a", "question_asked", {
          questions: [{ question: "Which layout should I use?" }],
        }),
      ),
    ).toMatchObject({ kind: "question", label: "question", text: "Which layout should I use?" });

    expect(
      activityOf(
        event(4, "s_a", "message_received", {
          from: "api-work",
          message: "The endpoint is ready.",
        }),
      ),
    ).toMatchObject({ kind: "message", label: "from api-work", text: "The endpoint is ready." });

    expect(
      activityOf(event(5, "s_a", "tool_error", { name: "Bash", error: "exit 1" })),
    ).toMatchObject({ kind: "error", label: "Bash failed", text: "exit 1" });
  });

  it("does not let bookkeeping erase the useful event before it", () => {
    expect(activityOf(event(6, "s_a", "tool_result", { result: "ok" }))).toBeNull();
    expect(activityOf(event(7, "s_a", "turn_end", { reason: "end_turn" }))).toBeNull();
    expect(activityOf(event(8, "s_a", "session_ended", { status: "completed" }))).toBeNull();
  });
});

describe("absorb", () => {
  it("keeps the newest meaningful activity per session", () => {
    const map = absorb(new Map(), [
      event(1, "s_a", "turn", { text: "first" }),
      event(2, "s_b", "tool_call", { name: "Read", args: { path: "README.md" } }),
      event(3, "s_a", "tool_call", { name: "Bash", args: { command: "pnpm test" } }),
    ]);
    expect(map.get("s_a")).toMatchObject({ label: "Bash", text: "pnpm test" });
    expect(map.get("s_b")).toMatchObject({ label: "Read", text: "README.md" });
  });

  it("does not let a late seed overwrite a newer live frame", () => {
    const live = absorb(new Map(), [event(9, "s_a", "turn", { text: "newest" })]);
    const seeded = absorb(live, [
      event(4, "s_a", "tool_call", { name: "Read", args: { path: "old.ts" } }),
    ]);
    expect(seeded.get("s_a")?.text).toBe("newest");
  });

  it("returns the same map when only ignored or empty events land", () => {
    const prev: ReadonlyMap<string, Activity> = absorb(new Map(), [
      event(1, "s_a", "turn", { text: "hi" }),
    ]);
    expect(absorb(prev, [event(2, "s_a", "turn", { text: "   " })])).toBe(prev);
    expect(absorb(prev, [event(3, "s_a", "tool_result", { result: "ok" })])).toBe(prev);
    expect(absorb(prev, [])).toBe(prev);
  });
});

describe("plain", () => {
  it("drops fenced code entirely", () => {
    expect(plain("Fixed it:\n\n```ts\nconst x = 1;\n```\n\nRun the tests.")).toBe(
      "Fixed it: Run the tests.",
    );
  });

  it("unwraps an unterminated fence too, so a streaming turn reads as prose", () => {
    expect(plain("Here:\n```\nhalf a diff")).toBe("Here:");
  });

  it("keeps the text of marks it strips", () => {
    expect(plain("## Done\n\n- **two** files, `api.ts` and [routes](./r.ts)")).toBe(
      "Done two files, api.ts and routes",
    );
  });

  it("leaves snake_case alone", () => {
    expect(plain("renamed last_seen_master_seq")).toBe(
      "renamed last_seen_master_seq",
    );
  });
});
