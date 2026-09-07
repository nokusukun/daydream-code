import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { JournalEvent } from "@daydream-code/shared";
import type { NextMessage } from "@daydream-code/session";
import { NextMessageQueue, composerKeyAction } from "../src/views/Composer.js";
import {
  drawsNothing,
  nextMessagesAfter,
} from "../src/views/SessionPanel.js";

const next = (id: string, message: string, editing = false): NextMessage => ({
  deliveryId: id,
  message,
  images: [],
  createdAt: "2026-08-27T00:00:00.000Z",
  editing,
});

function event(type: string, payload: unknown): JournalEvent {
  return {
    id: 1,
    sessionId: "ses_1" as JournalEvent["sessionId"],
    type,
    payload,
    ts: "2026-08-27T00:00:00.000Z",
  };
}

describe("next message composer", () => {
  const ordinary = {
    canDefer: true,
    canEditPrevious: false,
    editing: false,
    canStop: false,
  };

  it("reserves shift-command-enter for queueing another message", () => {
    expect(
      composerKeyAction(
        { key: "Enter", metaKey: true, ctrlKey: false, shiftKey: true },
        ordinary,
      ),
    ).toBe("defer");
    expect(
      composerKeyAction(
        { key: "Enter", metaKey: true, ctrlKey: false, shiftKey: false },
        ordinary,
      ),
    ).toBe("send");
    expect(
      composerKeyAction(
        { key: "Enter", metaKey: true, ctrlKey: false, shiftKey: true },
        { ...ordinary, canDefer: false },
      ),
    ).toBe("send");
  });

  it("uses up on an empty composer to edit the newest queued message", () => {
    expect(
      composerKeyAction(
        { key: "ArrowUp", metaKey: false, ctrlKey: false, shiftKey: false },
        { ...ordinary, canEditPrevious: true },
      ),
    ).toBe("editPrevious");
    expect(
      composerKeyAction(
        { key: "Escape", metaKey: false, ctrlKey: false, shiftKey: false },
        { ...ordinary, editing: true },
      ),
    ).toBe("cancelEdit");
  });

  it("uses escape to stop unless an edit owns it", () => {
    const escape = {
      key: "Escape",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
    };
    expect(composerKeyAction(escape, { ...ordinary, canStop: true })).toBe(
      "stop",
    );
    expect(
      composerKeyAction(escape, {
        ...ordinary,
        canStop: true,
        editing: true,
      }),
    ).toBe("cancelEdit");
  });

  it("renders an ordered, independently cancellable queue", () => {
    const html = renderToStaticMarkup(
      <NextMessageQueue
        messages={[
          next("msg_1", "Run the release checks"),
          next("msg_2", "Then update the docs"),
          next("msg_3", "Finally run the build", true),
        ]}
        busyId={null}
        onCancel={() => undefined}
        onCancelEdit={() => undefined}
      />,
    );
    expect(html).toContain("Next message to send");
    expect(html).toContain("Then · 2");
    expect(html).toContain("Run the release checks");
    expect(html).toContain("Editing queued message");
    expect(html).toContain('aria-label="Cancel queued message"');
    expect(html).toContain('aria-label="Cancel queued message edit"');
  });

  it("follows queue events without drawing transcript rows", () => {
    const first = next("msg_1", "first");
    const second = next("msg_2", "second");
    const deferred = event("user_message_deferred", first);
    expect(nextMessagesAfter([], deferred)).toEqual([first]);
    expect(
      nextMessagesAfter([first], event("user_message_deferred", second)),
    ).toEqual([first, second]);
    expect(drawsNothing(deferred)).toBe(true);

    const edited = next("msg_2", "second, revised", true);
    const updated = event("user_message_updated", edited);
    expect(nextMessagesAfter([first, second], updated)).toEqual([first, edited]);
    expect(drawsNothing(updated)).toBe(true);

    const unrelated = event("user_message_cancelled", { deliveryId: "msg_other" });
    expect(nextMessagesAfter([first, edited], unrelated)).toEqual([first, edited]);

    const cancelled = event("user_message_cancelled", { deliveryId: "msg_1" });
    expect(nextMessagesAfter([first, edited], cancelled)).toEqual([edited]);
    expect(drawsNothing(cancelled)).toBe(true);
  });
});
