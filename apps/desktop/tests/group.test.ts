import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { JournalEvent } from "@daydream-code/shared";
import {
  cycleTitles,
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

  it("a trailing open run groups once the session is no longer live", () => {
    // A session that died mid-call leaves a dangling call behind, and that
    // call is not running: it folds like any other.
    const items = groupEvents([
      ev("tool_call", { name: "bash" }),
      ev("tool_result", { name: "bash" }),
      ev("tool_call", { name: "bash" }),
    ]);
    expect(items.length).toBe(1);
    expect(items[0]!.kind).toBe("tools");
  });

  it("keeps the call a live run is inside out of the fold", () => {
    const open = ev("tool_call", { name: "grep", id: "t3" });
    const items = groupEvents(
      [
        ev("tool_call", { name: "bash", id: "t1" }),
        ev("tool_result", { toolCallId: "t1" }),
        ev("tool_call", { name: "write", id: "t2" }),
        ev("tool_result", { toolCallId: "t2" }),
        open,
      ],
      { live: true },
    );
    expect(items.map((i) => i.kind)).toEqual(["tools", "event"]);
    const group = items[0]!;
    expect(group.kind === "tools" && group.events.length).toBe(4);
    expect(items[1]).toEqual({ kind: "event", event: open, running: true });
  });

  it("keeps the newest settled call visible while the thread stays live", () => {
    const latestCall = ev("tool_call", { name: "bash", id: "t2" });
    const latestResult = ev("tool_result", { toolCallId: "t2" });
    const items = groupEvents(
      [
        ev("tool_call", { name: "bash", id: "t1" }),
        ev("tool_result", { toolCallId: "t1" }),
        latestCall,
        latestResult,
      ],
      { live: true },
    );
    expect(items.map((i) => i.kind)).toEqual(["event", "event", "event", "event"]);
    expect(items.at(-2)).toEqual({ kind: "event", event: latestCall });
    expect(items.at(-1)).toEqual({ kind: "event", event: latestResult });
  });

  it("pins the latest settled call beside an older collapsed chain", () => {
    const latestCall = ev("tool_call", { name: "grep", id: "t3" });
    const latestResult = ev("tool_result", { toolCallId: "t3" });
    const items = groupEvents(
      [
        ev("tool_call", { name: "bash", id: "t1" }),
        ev("tool_result", { toolCallId: "t1" }),
        ev("tool_call", { name: "write", id: "t2" }),
        ev("tool_result", { toolCallId: "t2" }),
        latestCall,
        latestResult,
      ],
      { live: true },
    );

    expect(items.map((item) => item.kind)).toEqual(["tools", "event", "event"]);
    expect(items[1]).toEqual({ kind: "event", event: latestCall });
    expect(items[2]).toEqual({ kind: "event", event: latestResult });
  });

  it("folds the previously pinned call when another visible event takes focus", () => {
    const items = groupEvents(
      [
        ev("tool_call", { name: "bash", id: "t1" }),
        ev("tool_result", { toolCallId: "t1" }),
        ev("tool_call", { name: "write", id: "t2" }),
        ev("tool_result", { toolCallId: "t2" }),
        ev("turn", { text: "done" }),
      ],
      { live: true },
    );

    expect(items.map((item) => item.kind)).toEqual(["tools", "event"]);
  });

  it("pins the latest terminal file change outside the older chain", () => {
    // Codex emits file-change items only after the patch finishes, so there is
    // no separate tool_result row to close either call.
    const items = groupEvents(
      [
        ev("tool_call", {
          id: "patch-1",
          name: "file_change",
          status: "completed",
        }),
        ev("tool_call", {
          id: "patch-2",
          name: "file_change",
          status: "completed",
        }),
        ev("tool_call", {
          id: "patch-3",
          name: "file_change",
          status: "failed",
        }),
      ],
      { live: true },
    );
    expect(items.map((i) => i.kind)).toEqual(["tools", "event"]);
  });

  it("keeps a call with an in-progress status unfolded", () => {
    const open = ev("tool_call", {
      id: "patch-1",
      name: "future_streaming_tool",
      status: "in_progress",
    });
    expect(groupEvents([open], { live: true })).toEqual([
      { kind: "event", event: open, running: true },
    ]);
  });

  /*
   * A parallel batch is journaled call, call, call and then answered in
   * whatever order the calls finish, so "the one running" is a set, and
   * results arrive out of order.
   */
  it("unfolds every call still in flight, matching results by id", () => {
    const first = ev("tool_call", { name: "a", id: "t1" });
    const third = ev("tool_call", { name: "c", id: "t3" });
    const items = groupEvents(
      [
        ev("tool_call", { name: "x", id: "t0" }),
        ev("tool_result", { toolCallId: "t0" }),
        first,
        ev("tool_call", { name: "b", id: "t2" }),
        third,
        ev("tool_result", { toolCallId: "t2" }),
      ],
      { live: true },
    );
    expect(items.map((i) => i.kind)).toEqual(["tools", "event", "event"]);
    expect(items[1]).toEqual({ kind: "event", event: first, running: true });
    expect(items[2]).toEqual({ kind: "event", event: third, running: true });
  });

  /*
   * Some drivers journal a bare result with no id. Pairing only by id would
   * report every one of their calls as still running.
   */
  it("pairs id-less results with the oldest open call", () => {
    const latestCall = ev("tool_call", { name: "c" });
    const latestResult = ev("tool_result", { name: "c" });
    const items = groupEvents(
      [
        ev("tool_call", { name: "a" }),
        ev("tool_result", { name: "a" }),
        ev("tool_call", { name: "b" }),
        ev("tool_result", { name: "b" }),
        latestCall,
        latestResult,
      ],
      { live: true },
    );
    expect(items.map((i) => i.kind)).toEqual(["tools", "event", "event"]);
    expect(items[1]).toEqual({ kind: "event", event: latestCall });
    expect(items[2]).toEqual({ kind: "event", event: latestResult });
  });

  it("only the run at the end of the feed can hold a running call", () => {
    const items = groupEvents(
      [
        ev("tool_call", { name: "a", id: "t1" }),
        ev("tool_call", { name: "b", id: "t2" }),
        ev("tool_result", { toolCallId: "t2" }),
        // A reply proves t1 returned, whatever the journal shows.
        ev("turn", { text: "done" }),
      ],
      { live: true },
    );
    expect(items.map((i) => i.kind)).toEqual(["tools", "event"]);
  });

  it("a lone call in flight stays inline rather than becoming a group of one", () => {
    const open = ev("tool_call", { name: "bash", id: "t1" });
    expect(groupEvents([open], { live: true })).toEqual([
      { kind: "event", event: open, running: true },
    ]);
  });

  it("keeps an accepted user message visible until the driver takes it", () => {
    const queued = ev("user_message_queued", {
      deliveryId: "msg_1",
      text: "also check the retry path",
    });
    expect(groupEvents([queued])).toEqual([{ kind: "event", event: queued }]);

    const injected = ev("user_injected", {
      deliveryId: "msg_1",
      kind: "user",
      text: "also check the retry path",
    });
    // Acceptance bookkeeping is replaced by the normal durable You row,
    // rather than rendering the same message twice.
    expect(groupEvents([queued, injected])).toEqual([
      { kind: "event", event: injected },
    ]);
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
  it("labels an accepted message as pending", () => {
    const html = renderToStaticMarkup(
      createElement(Event, {
        event: ev("user_message_queued", {
          deliveryId: "msg_1",
          text: "one more thing",
        }),
        names: new Map<string, string>(),
        changed: new Map(),
      }),
    );

    expect(html).toContain("entry-pending");
    expect(html).toContain("entry-mark-you");
    expect(html).toContain("pending");
    expect(html).toContain("one more thing");
  });

  it("marks a call still in flight", () => {
    const call = ev("tool_call", { name: "Bash", args: { command: "pnpm test" } });
    const live = renderToStaticMarkup(
      createElement(Event, {
        event: call,
        names: new Map<string, string>(),
        changed: new Map(),
        running: true,
      }),
    );
    const settled = renderToStaticMarkup(
      createElement(Event, {
        event: call,
        names: new Map<string, string>(),
        changed: new Map(),
      }),
    );

    expect(live).toContain("tool-running");
    expect(settled).not.toContain("tool-running");
  });

  it("renders the generated title before the opening task", () => {
    const html = renderToStaticMarkup(
      createElement(Event, {
        event: ev("session_started", {
          title: "Repair the compact toolbar",
          task: "Fix **this flow**",
          driver: "mock",
          contextMessages: 0,
          resumed: false,
        }),
        names: new Map<string, string>(),
        changed: new Map(),
      }),
    );

    expect(html).toContain("cycle-boundary-start");
    expect(html).toContain("Repair the compact toolbar");
    expect(html).toContain("entry-mark-you");
    expect(html).toContain("<strong>this flow</strong>");
    expect(html).toContain("thread started · mock");
    expect(html.indexOf("cycle-boundary-start")).toBeLessThan(
      html.indexOf("entry-mark-you"),
    );
  });

  it("keeps the closing edge compact instead of repeating the generated title", () => {
    const html = renderToStaticMarkup(
      createElement(Event, {
        event: ev("session_ended", {
          status: "completed",
          title: "Repair the compact toolbar",
          tldr: "done",
        }),
        names: new Map<string, string>(),
        changed: new Map(),
      }),
    );

    expect(html).toContain("cycle-boundary-end");
    expect(html).not.toContain('<h3 class="cycle-title"');
    expect(html).toContain("thread ended · completed");
  });
});

describe("cycleTitles", () => {
  it("derives an opening title for legacy events", () => {
    const start = ev("session_started", { task: "Fix the narrow toolbar. Then test." });
    const end = ev("session_ended", { status: "completed" });

    expect([...cycleTitles([start, end]).entries()]).toEqual([
      [start.id, "Fix the narrow toolbar"],
    ]);
  });

  it("keeps separate titles for consecutive cycles", () => {
    const firstStart = ev("session_started", { title: "First cycle", task: "one" });
    const firstEnd = ev("session_ended", { title: "First cycle" });
    const secondStart = ev("session_started", { title: "Second cycle", task: "two" });
    const secondEnd = ev("session_ended", { title: "Updated second cycle" });

    expect([...cycleTitles([firstStart, firstEnd, secondStart, secondEnd]).values()])
      .toEqual(["First cycle", "Second cycle"]);
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
