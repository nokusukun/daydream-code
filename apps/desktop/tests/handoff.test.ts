import { describe, expect, it } from "vitest";
import type { SessionRecord } from "@daydream-code/shared";
import { handoffStage, stageHandoff } from "../src/handoff.js";

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "ses_1",
    projectId: "prj_1",
    threadId: "thr_1",
    name: "fix-the-bug",
    title: "Fix the bug",
    task: "fix the bug",
    driver: "claude",
    modelId: "claude-opus-5",
    effort: "high",
    fastMode: true,
    status: "completed",
    lastSeenMasterSeq: 0,
    summary: null,
    tldr: null,
    archivedAt: null,
    startedAt: "2026-08-28T00:00:00.000Z",
    endedAt: "2026-08-28T00:01:00.000Z",
    usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
    ...overrides,
  } as SessionRecord;
}

describe("handoff staging", () => {
  it("carries the source's identity and current agent binding", () => {
    stageHandoff(record(), "transcript");
    const stage = handoffStage();
    expect(stage).toEqual({
      sessionId: "ses_1",
      name: "fix-the-bug",
      title: "Fix the bug",
      driver: "claude",
      modelId: "claude-opus-5",
      effort: "high",
      fastMode: true,
      mode: "transcript",
    });
  });

  it("maps the summarize menu action to summary mode and restages cleanly", () => {
    stageHandoff(record(), "transcript");
    stageHandoff(record({ id: "ses_2", name: "other" } as never), "summary");
    const stage = handoffStage();
    expect(stage?.sessionId).toBe("ses_2");
    expect(stage?.mode).toBe("summary");
  });

  it("keeps default model/effort and standard speed without freezing provider values", () => {
    stageHandoff(record({ modelId: null, effort: null } as never), "summary");
    const stage = handoffStage();
    expect(stage?.modelId).toBeNull();
    expect(stage?.effort).toBeNull();
    expect(stage?.fastMode).toBe(true);
  });
});
