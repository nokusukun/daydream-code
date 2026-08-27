import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { contextCopyText } from "../src/text-context.js";
import { Entry } from "../src/views/Entry.js";

describe("thread entry copy source", () => {
  it("keeps exact source separate from rendered labels and previews", () => {
    const source = "First line\n\n```ts\nconst value = 'full';\n```";
    const html = renderToStaticMarkup(
      <Entry kind="reply" label="reply" time="12:34" copyText={source}>
        First line…
      </Entry>,
    );

    expect(html).toContain(
      'data-copy-text="First line\n\n```ts\nconst value = &#x27;full&#x27;;\n```"',
    );
    expect(html).toContain("First line…");
  });

  it("does not offer an empty row as copyable", () => {
    const html = renderToStaticMarkup(
      <Entry kind="meta" copyText="   ">
        session ended
      </Entry>,
    );
    expect(html).not.toContain("data-copy-text");
  });

  it("prefers the active selection, then falls back to the whole entry", () => {
    expect(contextCopyText("selected words", "whole message")).toBe("selected words");
    expect(contextCopyText("", "whole message")).toBe("whole message");
    expect(contextCopyText("  ", "  ")).toBeNull();
  });
});
