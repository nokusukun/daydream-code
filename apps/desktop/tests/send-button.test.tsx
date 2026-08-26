import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SendButton } from "../src/views/Composer.js";

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

  it("wears the running meter in flight, and says so", () => {
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
});
