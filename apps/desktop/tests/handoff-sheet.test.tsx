import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

// These render through renderToStaticMarkup under node, where there is no DOM.
// ModelSelector reads localStorage in a useState initializer (favorites, at
// render time, not in an effect), so the global has to exist before render.
const stored = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => void stored.set(key, value),
  removeItem: (key: string) => void stored.delete(key),
});

vi.mock("../src/harness.js", () => ({
  useHarness: () => ({
    api: {
      models: () => Promise.resolve([]),
      handoff: () => Promise.resolve({ id: "ses_new" }),
    },
    select: () => undefined,
    setOverlay: () => undefined,
    modelLabel: (driver: string, modelId: string | null) => ({
      label: modelId ?? driver,
    }),
  }),
}));

import { HandoffSheet } from "../src/views/HandoffSheet.js";
import { stageHandoff } from "../src/handoff.js";
import type { SessionRecord } from "@daydream-code/shared";

function source(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "ses_src",
    name: "fix-the-bug",
    title: "Fix the bug",
    driver: "claude",
    modelId: "claude-opus-5",
    effort: null,
    fastMode: false,
    ...overrides,
  } as SessionRecord;
}

describe("HandoffSheet", () => {
  // Order matters: the staging slot is module-level and starts empty, so the
  // no-source path is only reachable before anything in this file stages.
  it("teaches the gesture when opened without a staged source", () => {
    const html = renderToStaticMarkup(createElement(HandoffSheet));
    expect(html).toContain("Right-click a thread");
    expect(html).not.toContain("start thread");
  });

  it("renders the transcript mode with the source named and the mode explained", () => {
    stageHandoff(source(), "transcript");
    const html = renderToStaticMarkup(createElement(HandoffSheet));
    expect(html).toContain("handoff to new thread");
    expect(html).toContain("fix-the-bug");
    expect(html).toContain("Fix the bug");
    expect(html).toContain("replayed transcript");
    expect(html).toContain("left exactly as it is");
    expect(html).toContain("start thread");
  });

  it("renders the summary mode with its own title and note", () => {
    stageHandoff(source(), "summary");
    const html = renderToStaticMarkup(createElement(HandoffSheet));
    expect(html).toContain("summarize to new thread");
    expect(html).toContain("summary of this thread");
    expect(html).not.toContain("replayed transcript");
  });
});
