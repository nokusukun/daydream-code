import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { JournalEvent } from "@daydream-code/shared";
import {
  ContextRebuildNotice,
  pendingContextRebuild,
} from "../src/views/Composer.js";

function event(
  id: number,
  type: string,
  payload: unknown = {},
): JournalEvent {
  return {
    id,
    sessionId: "s_1" as JournalEvent["sessionId"],
    ts: new Date(id).toISOString(),
    type,
    payload,
  };
}

describe("context rebuild undo", () => {
  it("offers the latest cross-provider switch until the next run starts", () => {
    const changed = event(2, "model_changed", {
      from: { driver: "claude" },
      to: { driver: "codex" },
      contextRebuilt: true,
    });
    expect(pendingContextRebuild([event(1, "session_ended"), changed])).toEqual({
      eventId: 2,
      driver: "codex",
    });
    expect(
      pendingContextRebuild([changed, event(3, "session_started")]),
    ).toBeNull();
  });

  it("does not offer same-provider changes or a completed undo", () => {
    expect(
      pendingContextRebuild([
        event(1, "model_changed", { contextRebuilt: false }),
      ]),
    ).toBeNull();
    expect(
      pendingContextRebuild([
        event(2, "model_changed", {
          contextRebuilt: false,
          undo: true,
        }),
      ]),
    ).toBeNull();
  });

  it("renders a persistent, actionable explanation", () => {
    const onUndo = vi.fn();
    const html = renderToStaticMarkup(
      createElement(ContextRebuildNotice, {
        change: { eventId: 2, driver: "codex" },
        busy: false,
        onUndo,
      }),
    );
    expect(html).toContain("Context will rebuild on your next message");
    expect(html).toContain("Switching to codex");
    expect(html).toContain("Undo");
  });
});
