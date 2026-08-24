import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { JournalEvent } from "@daydream-code/shared";
import {
  drawsNothing,
  Event,
  groupEvents,
  groupLabel,
} from "../src/views/SessionPanel.js";

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

  /*
   * Claude journals a thinking event per block whether or not any text came
   * with it, so these sit between almost every tool call. They draw nothing,
   * and a run they split rendered as a column of "2 tool calls" rows.
   */
  it("an empty thinking event does not break a run", () => {
    const items = groupEvents([
      ev("tool_call", { name: "a" }),
      ev("tool_result", { name: "a" }),
      ev("thinking", { text: "" }),
      ev("tool_call", { name: "b" }),
      ev("tool_result", { name: "b" }),
      ev("thinking", { text: "   " }),
      ev("tool_call", { name: "c" }),
      ev("tool_result", { name: "c" }),
    ]);
    expect(items.length).toBe(1);
    const group = items[0]!;
    expect(group.kind === "tools" && group.events.length).toBe(6);
  });

  it("drops events that draw nothing rather than emitting an empty row", () => {
    const items = groupEvents([
      ev("turn", { text: "hi" }),
      ev("turn", { text: "" }),
      ev("thinking", { text: "" }),
      ev("user_injected", { text: "  " }),
    ]);
    expect(items.length).toBe(1);
  });

  it("a captionless screenshot is not nothing", () => {
    const withImage = ev("user_injected", {
      text: "",
      images: [{ type: "image", blobId: "blob_1" }],
    });
    expect(drawsNothing(withImage)).toBe(false);
    const items = groupEvents([
      ev("tool_call", { name: "a" }),
      ev("tool_result", { name: "a" }),
      withImage,
      ev("tool_call", { name: "b" }),
      ev("tool_result", { name: "b" }),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["event", "event", "event", "event", "event"]);
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

describe("Event", () => {
  it("renders the opening task as a You message before session metadata", () => {
    const html = renderToStaticMarkup(
      createElement(Event, {
        event: ev("session_started", {
          task: "Fix **this flow**",
          driver: "mock",
          contextMessages: 0,
          resumed: false,
        }),
        names: new Map<string, string>(),
        changed: new Map(),
      }),
    );

    expect(html).toContain("entry-mark-you");
    expect(html).toContain("<strong>this flow</strong>");
    expect(html).toContain("session started · mock");
    expect(html.indexOf("entry-mark-you")).toBeLessThan(
      html.indexOf("entry-mark-meta"),
    );
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
