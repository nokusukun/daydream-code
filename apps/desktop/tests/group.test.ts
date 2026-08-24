import { describe, expect, it } from "vitest";
import type { JournalEvent } from "@daydream-code/shared";
import { groupEvents, groupLabel } from "../src/views/SessionPanel.js";

let nextId = 1;
function ev(type: string, payload: unknown = {}): JournalEvent {
  return {
    id: nextId++,
    sessionId: "ses_x" as JournalEvent["sessionId"],
    ts: "2026-08-23T00:00:00.000Z",
    type,
    payload,
  };
}

describe("groupEvents", () => {
  it("groups a consecutive run of >=2 tool calls with their results", () => {
    const events = [
      ev("turn", { text: "hi" }),
      ev("tool_call", { name: "bash" }),
      ev("tool_result", { name: "bash" }),
      ev("tool_call", { name: "write" }),
      ev("tool_result", { name: "write" }),
      ev("turn", { text: "done" }),
    ];
    const items = groupEvents(events);
    expect(items.map((i) => i.kind)).toEqual(["event", "tools", "event"]);
    const group = items[1]!;
    expect(group.kind === "tools" && group.events.length).toBe(4);
  });

  it("leaves a single tool call inline", () => {
    const items = groupEvents([
      ev("tool_call", { name: "bash" }),
      ev("tool_result", { name: "bash" }),
      ev("turn", { text: "x" }),
    ]);
    expect(items.every((i) => i.kind === "event")).toBe(true);
  });

  it("non-tool events (thinking, turn_end) break a run", () => {
    const items = groupEvents([
      ev("tool_call", { name: "a" }),
      ev("tool_result", { name: "a" }),
      ev("thinking", { text: "hmm" }),
      ev("tool_call", { name: "b" }),
      ev("tool_result", { name: "b" }),
    ]);
    // two 1-call runs, each inline, thinking between
    expect(items.every((i) => i.kind === "event")).toBe(true);
    expect(items.length).toBe(5);
  });

  it("a trailing open run still groups (live streaming)", () => {
    const items = groupEvents([
      ev("tool_call", { name: "bash" }),
      ev("tool_result", { name: "bash" }),
      ev("tool_call", { name: "bash" }),
    ]);
    expect(items.length).toBe(1);
    expect(items[0]!.kind).toBe("tools");
  });

  it("tool_error joins the run", () => {
    const items = groupEvents([
      ev("tool_call", { name: "bash" }),
      ev("tool_error", { name: "bash", error: "boom" }),
      ev("tool_call", { name: "bash" }),
      ev("tool_result", { name: "bash" }),
    ]);
    expect(items.length).toBe(1);
    expect(items[0]!.kind).toBe("tools");
  });
});

describe("groupLabel", () => {
  it("tallies call names", () => {
    const label = groupLabel([
      ev("tool_call", { name: "bash" }),
      ev("tool_result", { name: "bash" }),
      ev("tool_call", { name: "bash" }),
      ev("tool_call", { name: "write" }),
    ]);
    expect(label).toBe("bash ×2, write");
  });

  it("falls back through toolName/tool keys", () => {
    expect(groupLabel([ev("tool_call", { toolName: "grep" })])).toBe("grep");
    expect(groupLabel([ev("tool_call", {})])).toBe("tool");
  });
});
