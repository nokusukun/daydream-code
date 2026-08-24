import { describe, expect, it } from "vitest";
import { App } from "@daydream-code/kernel";
import {
  ProjectId,
  SessionId,
  ThreadId,
  nowIso,
  zeroUsage,
  type JournalEvent,
  type SessionRecord,
} from "@daydream-code/shared";
import MechanicalSummarizer from "@daydream-code/summarize/mechanical";

const sessionId = SessionId("s_test");

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: sessionId,
    projectId: ProjectId("p_test"),
    threadId: ThreadId("t_test"),
    name: "test-session",
    title: "Refactor the auth token check",
    task: "Refactor the auth token check without changing the public API",
    driver: "claude",
    modelId: null,
    status: "completed",
    lastSeenMasterSeq: 0,
    startedAt: nowIso(),
    endedAt: null,
    summary: null,
    tldr: null,
    usage: zeroUsage(),
    ...overrides,
  };
}

let nextId = 1;
const ev = (type: string, payload: unknown): JournalEvent => ({
  id: nextId++,
  sessionId,
  type,
  payload,
  ts: nowIso(),
});

async function makeSummarizer(): Promise<MechanicalSummarizer> {
  const app = new App();
  const ctx = app.rootCtx;
  ctx.plugin(MechanicalSummarizer);
  await app.settle();
  return ctx.get<MechanicalSummarizer>("summarizer")!;
}

describe("MechanicalSummarizer.title", () => {
  it("takes the first sentence and drops trailing punctuation", async () => {
    const summarizer = await makeSummarizer();
    expect(
      await summarizer.title({ task: "Fix the login bug. Then ship it." }),
    ).toBe("Fix the login bug");
  });

  it("uses the first non-empty line of a multi-line instruction", async () => {
    const summarizer = await makeSummarizer();
    expect(
      await summarizer.title({ task: "\n\n  update the docs  \nand tests" }),
    ).toBe("update the docs");
  });

  it("truncates long instructions and never returns empty", async () => {
    const summarizer = await makeSummarizer();
    const long = await summarizer.title({ task: "x".repeat(200) });
    expect(long.length).toBeLessThanOrEqual(72);
    expect(long.endsWith("…")).toBe(true);
    expect(await summarizer.title({ task: "   " })).toBe("untitled session");
  });
});

describe("MechanicalSummarizer.turnSummary", () => {
  it("uses the last turn's first sentence plus tool activity, within 200 chars", async () => {
    const summarizer = await makeSummarizer();
    const line = await summarizer.turnSummary({
      session: makeSession(),
      turnEvents: [
        ev("turn", { text: "Mapped the token flow. Ready to edit." }),
        ev("tool_call", { toolName: "bash", args: { command: "ls" } }),
        ev("tool_call", { toolName: "bash", args: { command: "cat auth.ts" } }),
        ev("tool_call", { toolName: "write", args: { file_path: "src/auth.ts" } }),
        ev("turn", {
          text: "Rewrote validateToken in auth.ts. All existing tests still pass.",
        }),
      ],
    });
    expect(line).toContain("Rewrote validateToken in auth.ts.");
    expect(line).not.toContain("All existing tests still pass");
    expect(line).toContain("(3 tool calls: bash x2, write x1)");
    expect(line.length).toBeLessThanOrEqual(200);
    expect(line).not.toContain("\n");
  });

  it("handles a turn with no events at all", async () => {
    const summarizer = await makeSummarizer();
    const line = await summarizer.turnSummary({
      session: makeSession(),
      turnEvents: [],
    });
    expect(line.length).toBeGreaterThan(0);
    expect(line.length).toBeLessThanOrEqual(200);
    expect(line).toContain("no events");
  });

  it("caps the line at 200 chars for very long turn text", async () => {
    const summarizer = await makeSummarizer();
    const line = await summarizer.turnSummary({
      session: makeSession(),
      turnEvents: [ev("turn", { text: `${"very long unbroken text ".repeat(30)}end` })],
    });
    expect(line.length).toBeLessThanOrEqual(200);
  });

  it("is deterministic for identical input", async () => {
    const summarizer = await makeSummarizer();
    const events = [
      ev("turn", { text: "Did a thing. Then another." }),
      ev("tool_call", { toolName: "bash", args: { command: "pwd" } }),
    ];
    const input = { session: makeSession(), turnEvents: events };
    expect(await summarizer.turnSummary(input)).toBe(
      await summarizer.turnSummary(input),
    );
  });
});

describe("MechanicalSummarizer.sessionSummary", () => {
  const finalText =
    "Rewrote validateToken in src/auth.ts and updated the middleware wiring; " +
    "all tests pass and the public API is unchanged as requested by the task.";

  function richEvents(): JournalEvent[] {
    return [
      ev("session_started", { task: "refactor" }),
      ev("turn", { text: "Explored the codebase. Found the token check." }),
      ev("tool_call", { toolName: "read", args: { file_path: "src/auth.ts" } }),
      ev("tool_call", {
        toolName: "bash",
        args: { command: "pnpm test", cwd: "/repo" },
      }),
      ev("tool_call", {
        toolName: "write",
        input: { nested: { path: "src/middleware/token.ts" } },
      }),
      ev("tool_call", {
        toolName: "read",
        args: { files: [{ filename: "docs/auth.md" }] },
      }),
      ev("tool_call", { toolName: "read", args: { file_path: "src/auth.ts" } }),
      ev("turn", { text: finalText }),
      ev("session_ended", { reason: "completed" }),
    ];
  }

  it("reports task, status, files, tool counts, turns, final text, and the discipline line", async () => {
    const summarizer = await makeSummarizer();
    const session = makeSession();
    const { summary, tldr } = await summarizer.sessionSummary({
      session,
      events: richEvents(),
      reason: "completed",
    });
    expect(summary).toContain(`Task: ${session.task}`);
    expect(summary).toContain("Status: completed");
    // Path-ish args found anywhere in tool_call payloads, deduped.
    const filesLine = summary
      .split("\n")
      .find((l) => l.startsWith("Files touched:"))!;
    expect(filesLine).toContain("src/auth.ts");
    expect(filesLine).toContain("src/middleware/token.ts");
    expect(filesLine).toContain("docs/auth.md");
    expect(filesLine.match(/src\/auth\.ts/g)).toHaveLength(1);
    // Tool call counts by name.
    expect(summary).toContain("read x3");
    expect(summary).toContain("bash x1");
    expect(summary).toContain("write x1");
    expect(summary).toContain("Turns: 2");
    expect(summary).toContain(finalText);
    expect(summary).toContain("Facts only; no interpretation.");
    expect(tldr).toBe(finalText.slice(0, 120));
    expect(tldr.length).toBeLessThanOrEqual(120);
  });

  it("truncates the final turn text to 500 chars", async () => {
    const summarizer = await makeSummarizer();
    const long = "x".repeat(900);
    const { summary } = await summarizer.sessionSummary({
      session: makeSession(),
      events: [ev("turn", { text: long })],
      reason: "completed",
    });
    const finalLine = summary.split("\n").find((l) => l.startsWith("Final:"))!;
    expect(finalLine.length).toBeLessThanOrEqual("Final: ".length + 500);
    expect(summary).not.toContain(long);
  });

  it("falls back to the task for the tldr when there is no turn text", async () => {
    const summarizer = await makeSummarizer();
    const session = makeSession();
    const { summary, tldr } = await summarizer.sessionSummary({
      session,
      events: [ev("tool_call", { toolName: "bash", args: { command: "ls" } })],
      reason: "failed",
    });
    expect(tldr).toBe(session.task.slice(0, 120));
    expect(summary).toContain("Status: failed");
    expect(summary).toContain("Turns: 0");
  });

  it("handles an empty/killed session with a mechanical abrupt-end note", async () => {
    const summarizer = await makeSummarizer();
    const session = makeSession({ status: "killed" });
    const { summary, tldr } = await summarizer.sessionSummary({
      session,
      events: [],
      reason: "killed",
    });
    expect(summary).toContain("abruptly");
    expect(summary).toContain("killed");
    expect(summary).toContain(`Task: ${session.task}`);
    expect(summary).toContain("Facts only; no interpretation.");
    expect(tldr).toBe(session.task.slice(0, 120));
  });

  it("never speculates: output contains only strings present in the input", async () => {
    const summarizer = await makeSummarizer();
    const session = makeSession();
    const { summary } = await summarizer.sessionSummary({
      session,
      events: richEvents(),
      reason: "completed",
    });
    // Every non-scaffold token of content traces back to the input facts.
    expect(summary).not.toMatch(/probably|likely|seems|should|might/i);
  });
});
