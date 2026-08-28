import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SendButton, StopButton } from "../src/views/Composer.js";

function render(props: Partial<Parameters<typeof SendButton>[0]> = {}): string {
  return renderToStaticMarkup(
    <SendButton
      busy={false}
      disabled={false}
      label="Send"
      busyLabel="Sending"
      onClick={() => undefined}
      {...props}
    />,
  );
}

describe("<SendButton>", () => {
  it("keeps the verb the label used to print, as the accessible name", () => {
    const html = render();
    // The icon carries no text, so this is the only thing a screen reader —
    // or a hover — has to go on.
    expect(html).toContain('aria-label="Send"');
    expect(html).toContain('title="Send (⌘⏎)"');
    expect(html).toContain("<svg");
    expect(html).not.toContain("disabled");
  });

  it("distinguishes dispatching a run from steering one", () => {
    expect(render({ label: "Dispatch", busyLabel: "Dispatching" })).toContain(
      'aria-label="Dispatch"',
    );
  });

  it("wears the running ring in flight, and says so", () => {
    const html = render({ busy: true });
    expect(html).toContain("glyph-running");
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="Sending…"');
    // Busy is also unclickable: a second dispatch would start a second run.
    expect(html).toContain("disabled");
  });

  it("is unavailable with nothing to send", () => {
    expect(render({ disabled: true })).toContain("disabled");
  });

  it("stays a single button when the thread has no defer action", () => {
    expect(render()).not.toContain("composer-send-split");
  });

  it("splits into send-now and send-later when a run is live", () => {
    const html = render({
      defer: { label: "Send when this thread ends", onClick: () => undefined },
    });
    expect(html).toContain("composer-send-split");
    expect(html).toContain('aria-label="Send when this thread ends"');
    expect(html).toContain("title=\"Send when this thread ends (⇧⌘⏎)\"");
    // Both segments share availability: queueing nothing is not a thing.
    expect(html).not.toContain("disabled");
  });

  it("disables both segments together", () => {
    const html = render({
      disabled: true,
      defer: { label: "Send when this thread ends", onClick: () => undefined },
    });
    expect(html.match(/disabled/g)?.length).toBe(2);
  });
});

describe("<StopButton>", () => {
  it("names the irreversible thing it does", () => {
    const html = renderToStaticMarkup(
      <StopButton stopping={false} onClick={() => undefined} />,
    );
    expect(html).toContain('aria-label="Stop this thread"');
    expect(html).toContain("btn-danger");
    expect(html).toContain("<svg");
    expect(html).not.toContain("disabled");
  });

  it("disarms after the first press — two clicks used to send two kills", () => {
    const html = renderToStaticMarkup(
      <StopButton stopping onClick={() => undefined} />,
    );
    expect(html).toContain("disabled");
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="Stopping…"');
  });
});
