/**
 * The "read more" clamp on large thread items.
 *
 * The old behavior was `short()` cutting a prose body at 4000 chars, mid-word,
 * with no way to read the rest — the tail of a long reply simply did not
 * exist in the UI. These pin the replacement: the full text reaches the row,
 * the view clamps it, and the clamp always hides something worth a click.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { JournalEvent } from "@daydream-code/shared";
import { Event, PROSE_CLAMP_CHARS, proseChunks } from "../src/views/SessionPanel.js";

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

function render(event: JournalEvent): string {
  return renderToStaticMarkup(
    <Event event={event} names={new Map()} changed={new Map()} />,
  );
}

/**
 * The markup a reader sees, minus `data-copy-text` — that attribute
 * deliberately carries the whole message so right-click copy gets the source,
 * not the clamp. The attribute value is HTML-escaped, so the quote scan is
 * safe.
 */
function visible(html: string): string {
  return html.replace(/ data-copy-text="[^"]*"/g, "");
}

const line = (n: number, len = 90): string => `p${n} ${"x".repeat(len)}`;

/** A body of `n` distinct lines, so lost content is detectable by name. */
function body(n: number): string {
  return Array.from({ length: n }, (_, i) => line(i)).join("\n");
}

describe("proseChunks", () => {
  it("leaves a short body as one chunk", () => {
    expect(proseChunks("hello")).toEqual(["hello"]);
  });

  it("leaves a body inside the slack whole — a clamp must hide something worth a click", () => {
    // ~5k chars: past the clamp point but within slack of it. Chunking this
    // would put a "read more" on two lines of tail.
    const text = body(55);
    expect(text.length).toBeGreaterThan(PROSE_CLAMP_CHARS);
    expect(proseChunks(text)).toEqual([text]);
  });

  it("chunks a genuinely large body and loses no line", () => {
    const text = body(200);
    const chunks = proseChunks(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("\n").split("\n")).toEqual(text.split("\n"));
  });
});

describe("read more on large rows", () => {
  it("renders a small reply whole, with no read more", () => {
    const html = render(ev("turn", { text: "a modest reply" }));
    expect(html).toContain("a modest reply");
    expect(html).not.toContain("read more");
  });

  it("clamps a large reply to its head behind a read more", () => {
    const text = body(300);
    const html = visible(render(ev("turn", { text })));
    expect(html).toContain("p0 ");
    // The tail is not rendered until opened…
    expect(html).not.toContain("p299 ");
    // …and the affordance says so, with the scale of what's hidden.
    expect(html).toMatch(/read more · ~\d+k characters/);
  });

  it("keeps the full message in the copy attribute — the clamp is display, not data", () => {
    // Before this, `copyText` got the same `short()` cut as the body, so
    // right-click copy on a long reply silently copied 4000 chars of it.
    const text = body(300);
    const html = render(ev("turn", { text }));
    expect(html).toContain("p299 ");
  });

  it("never renders the old silent cut: no ellipsis appended mid-body", () => {
    // `short()` marked its cut with a bare `…` glued to the 4000th char.
    // The clamp splits at line boundaries instead, so no line is ever cut.
    const text = body(300);
    const html = visible(render(ev("turn", { text })));
    expect(html).not.toContain("x…");
  });

  it("clamps thinking, user, and master rows the same way", () => {
    const text = body(300);
    for (const [type, payload] of [
      ["thinking", { text }],
      ["user_injected", { text }],
      ["master_injected", { text }],
      ["session_started", { task: text }],
    ] as const) {
      const html = visible(render(ev(type, payload)));
      expect(html, type).toContain("read more");
      expect(html, type).not.toContain("p299 ");
    }
  });
});
