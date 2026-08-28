import { describe, expect, it } from "vitest";
import type { JournalEvent } from "@daydream-code/shared";
import {
  transcriptLines,
  transcriptMessages,
  transcriptText,
} from "../src/transcript.js";

let seq = 0;
function event(type: string, payload: unknown): JournalEvent {
  seq += 1;
  return {
    id: seq,
    sessionId: "ses_test" as never,
    type,
    payload,
    ts: "2026-08-28T00:00:00.000Z",
  };
}

describe("transcript rebuild from the journal", () => {
  it("maps the conversational events and skips the private ones", () => {
    const lines = transcriptLines([
      event("session_started", { task: "fix the bug" }),
      event("thinking", { text: "hmm" }),
      event("turn", { text: "found it" }),
      event("tool_call", { name: "Bash", args: { command: "ls" } }),
      event("tool_result", { result: "file.ts" }),
      event("user_injected", { kind: "user", text: "also add a test" }),
      event("user_injected", { kind: "master_update", text: "[master] noise" }),
      event("user_injected", { kind: "ask", text: "sibling question" }),
      event("session_ended", { status: "completed", tldr: "done" }),
    ]);
    expect(lines.map((l) => l.role)).toEqual([
      "user",
      "assistant",
      "assistant",
      "assistant",
      "user",
      "user",
      "assistant",
    ]);
    expect(lines[0]?.text).toBe("fix the bug");
    expect(lines[2]?.text).toContain("Bash");
    expect(lines[4]?.text).toBe("also add a test");
    expect(lines[5]?.text).toContain("[from a sibling thread]");
    expect(lines[6]?.text).toContain("completed");
    // The master update contributed nothing.
    expect(lines.some((l) => l.text.includes("[master] noise"))).toBe(false);
  });

  it("merges consecutive same-role lines into one message", () => {
    const messages = transcriptMessages([
      event("turn", { text: "step one" }),
      event("tool_call", { name: "Read", args: {} }),
      event("tool_result", { result: "ok" }),
      event("session_started", { task: "continue" }),
      event("turn", { text: "step two" }),
    ]);
    expect(messages.map((m) => m.role)).toEqual(["assistant", "user", "assistant"]);
    expect(messages[0]?.content).toContain("step one");
    expect(messages[0]?.content).toContain("Read");
  });

  it("keeps the tail under budget and says what it dropped", () => {
    const events = Array.from({ length: 20 }, (_, i) =>
      event("turn", { text: `turn number ${i} ${"x".repeat(100)}` }),
    );
    const lines = transcriptLines(events, 500);
    expect(lines.length).toBeLessThan(20);
    // The first line is the elision marker, the last is the newest turn.
    expect(lines[0]?.text).toContain("elided");
    expect(lines[lines.length - 1]?.text).toContain("turn number 19");
    // Nothing from the dropped head survives.
    expect(lines.some((l) => l.text.includes("turn number 0 "))).toBe(false);
  });

  it("ships a single oversized line clipped rather than an empty transcript", () => {
    const lines = transcriptLines([event("turn", { text: "y".repeat(5000) })], 100);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text.length).toBeLessThanOrEqual(101);
  });

  it("contributes nothing for a fresh session", () => {
    expect(transcriptMessages([])).toEqual([]);
    expect(transcriptText([])).toBe("");
  });

  it("renders prose blocks with role labels", () => {
    const text = transcriptText([
      event("session_started", { task: "do it" }),
      event("turn", { text: "did it" }),
    ]);
    expect(text).toBe("[user]\ndo it\n\n[assistant]\ndid it");
  });

  it("survives malformed payloads by dropping them", () => {
    const lines = transcriptLines([
      event("turn", null),
      event("session_started", "not an object"),
      event("turn", { text: 42 }),
      event("turn", { text: "real" }),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe("real");
  });
});
