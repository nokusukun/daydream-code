import { describe, expect, it } from "vitest";
import {
  looksLikeMarkdown,
  parseInline,
  parseMarkdown,
  type Block,
  type Inline,
} from "../src/markdown.js";

/** Flatten an inline tree to its text, for assertions that only care about that. */
function text(nodes: Inline[]): string {
  return nodes
    .map((node) =>
      node.kind === "text" || node.kind === "code" ? node.text : text(node.children),
    )
    .join("");
}

function kinds(blocks: Block[]): string[] {
  return blocks.map((block) => block.kind);
}

describe("blocks", () => {
  it("splits paragraphs on blank lines and keeps soft wraps", () => {
    const blocks = parseMarkdown("one\ntwo\n\nthree");
    expect(kinds(blocks)).toEqual(["paragraph", "paragraph"]);
    expect(text((blocks[0] as { children: Inline[] }).children)).toBe("one\ntwo");
  });

  it("parses fences with a language, and keeps their whitespace verbatim", () => {
    const blocks = parseMarkdown("```ts\nconst a = 1;\n\n  indented\n```\nafter");
    expect(blocks[0]).toEqual({
      kind: "fence",
      lang: "ts",
      text: "const a = 1;\n\n  indented",
    });
    expect(blocks[1]!.kind).toBe("paragraph");
  });

  it("closes an unterminated fence at the end of input", () => {
    // Streaming output opens a fence long before it closes one.
    const blocks = parseMarkdown("text\n\n```sh\ngit status");
    expect(blocks[1]).toEqual({ kind: "fence", lang: "sh", text: "git status" });
  });

  it("does not read markdown inside a fence", () => {
    const blocks = parseMarkdown("```\n# not a heading\n- not a list\n```");
    expect(kinds(blocks)).toEqual(["fence"]);
  });

  it("parses headings, rules and quotes", () => {
    const blocks = parseMarkdown("## Title\n\n---\n\n> quoted\n> lines");
    expect(blocks[0]).toMatchObject({ kind: "heading", level: 2 });
    expect(blocks[1]!.kind).toBe("rule");
    const quote = blocks[2] as { kind: string; children: Block[] };
    expect(quote.kind).toBe("quote");
    expect(text((quote.children[0] as { children: Inline[] }).children)).toBe(
      "quoted\nlines",
    );
  });

  it("parses bullet and ordered lists, keeping the ordered start", () => {
    const bullets = parseMarkdown("- one\n- two\n") as [{ items: Block[][] }];
    expect(bullets[0].items).toHaveLength(2);

    const ordered = parseMarkdown("3. three\n4. four") as [
      { ordered: boolean; start: number; items: Block[][] },
    ];
    expect(ordered[0].ordered).toBe(true);
    expect(ordered[0].start).toBe(3);
    expect(ordered[0].items).toHaveLength(2);
  });

  it("keeps a fence nested inside a list item inside the item", () => {
    const blocks = parseMarkdown("- run it:\n\n  ```sh\n  ls -a\n  ```\n\n- then stop");
    const list = blocks[0] as { kind: string; items: Block[][] };
    expect(list.kind).toBe("list");
    expect(list.items).toHaveLength(2);
    expect(kinds(list.items[0]!)).toEqual(["paragraph", "fence"]);
    expect((list.items[0]![1] as { text: string }).text).toBe("ls -a");
  });

  it("nests an indented list inside the item above it", () => {
    const blocks = parseMarkdown("- one\n  - deep\n  - deeper\n- two");
    const list = blocks[0] as { items: Block[][] };
    expect(list.items).toHaveLength(2);
    expect(kinds(list.items[0]!)).toEqual(["paragraph", "list"]);
    expect((list.items[0]![1] as { items: Block[][] }).items).toHaveLength(2);
  });

  it("does not stall on a marker indented under four spaces", () => {
    // This class of input used to return without consuming a line, so the
    // block loop span forever and took the renderer down with it.
    for (const source of [
      " - fix the thing",
      "Summary:\n\n  - one\n  - two\n",
      "  1. first\n",
      "1. step one\n\n   - detail\n",
      "> here:\n>  - a\n",
    ]) {
      expect(parseMarkdown(source).length, source).toBeGreaterThan(0);
    }
  });

  it("counts the ordered delimiter in the content column", () => {
    // `1. ` is three columns, not two: a fence indented to match it must not
    // keep a stray leading space on every line.
    const blocks = parseMarkdown("1. run this:\n\n   ```sh\n   echo hi\n   echo bye\n   ```\n");
    const list = blocks[0] as { items: Block[][] };
    const fence = list.items[0]!.find((b) => b.kind === "fence") as { text: string };
    expect(fence.text).toBe("echo hi\necho bye");
  });

  it("survives a quote nested past any sane depth", () => {
    // 8k of legal text; recursing per level would overflow the stack, and
    // nothing upstream of this is behind an error boundary.
    expect(() => parseMarkdown("> ".repeat(4000) + "x")).not.toThrow();
  });

  it("lets a table interrupt a paragraph", () => {
    const blocks = parseMarkdown("Results:\n| a | b |\n| - | - |\n| 1 | 2 |");
    expect(kinds(blocks)).toEqual(["paragraph", "table"]);
  });

  it("consumes a malformed table header instead of stalling on it", () => {
    // The header and the delimiter row disagree on width, so the table branch
    // declines it and the paragraph branch has to be the one that eats it.
    expect(kinds(parseMarkdown("| a | b |\n| - |"))).toEqual(["paragraph"]);
  });

  it("always consumes a line, whatever it is given", () => {
    const alphabet = ["#", " ", "-", "*", "_", "`", "|", ">", "1.", "[", "]", "(", ")", "~", "a", "\n", "  ", "```", ":", "\\"];
    for (let n = 0; n < 4000; n += 1) {
      let source = "";
      for (let k = 0; k < 1 + (n % 40); k += 1) {
        source += alphabet[(n * 7 + k * 13) % alphabet.length]!;
      }
      // A parse that returns at all is the assertion: the failure mode this
      // guards is a hang, which no expect() would ever get to report.
      expect(Array.isArray(parseMarkdown(source))).toBe(true);
    }
  });

  it("ends a list at the following paragraph", () => {
    const blocks = parseMarkdown("- one\n- two\n\nAfter the list.");
    expect(kinds(blocks)).toEqual(["list", "paragraph"]);
  });

  it("parses a pipe table with alignment, padding ragged rows", () => {
    const blocks = parseMarkdown(
      "| a | b |\n| :- | --: |\n| 1 | 2 |\n| 3 |",
    );
    const table = blocks[0] as {
      kind: string;
      align: (string | null)[];
      head: Inline[][];
      rows: Inline[][][];
    };
    expect(table.kind).toBe("table");
    expect(table.align).toEqual(["left", "right"]);
    expect(table.head.map(text)).toEqual(["a", "b"]);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[1]!.map(text)).toEqual(["3", ""]);
  });

  it("leaves a lone pipe line as a paragraph", () => {
    expect(kinds(parseMarkdown("a | b"))).toEqual(["paragraph"]);
  });
});

describe("inline", () => {
  it("parses code spans before anything else", () => {
    const nodes = parseInline("run `git commit -m *now*` twice");
    expect(nodes[1]).toEqual({ kind: "code", text: "git commit -m *now*" });
  });

  it("lets a code span hold backticks", () => {
    expect(parseInline("`` a ` b ``")[0]).toEqual({ kind: "code", text: "a ` b" });
  });

  it("parses strong, em and strike", () => {
    const nodes = parseInline("**bold** _it_ ~~gone~~");
    expect(nodes.map((n) => n.kind)).toEqual([
      "strong",
      "text",
      "em",
      "text",
      "strike",
    ]);
  });

  it("does not italicise inside snake_case identifiers", () => {
    // The transcript is full of `ses_1k0m_x` and `tool_call_id`.
    const nodes = parseInline("session_id_field and a_b_c");
    expect(nodes).toEqual([{ kind: "text", text: "session_id_field and a_b_c" }]);
  });

  it("does not treat spaced asterisks as emphasis", () => {
    expect(parseInline("2 * 3 * 4")).toEqual([{ kind: "text", text: "2 * 3 * 4" }]);
  });

  it("honours backslash escapes", () => {
    expect(parseInline("\\*not em\\*")).toEqual([{ kind: "text", text: "*not em*" }]);
  });

  it("parses links, autolinks and bare urls", () => {
    expect(parseInline("[docs](https://x.dev/a)")[0]).toMatchObject({
      kind: "link",
      href: "https://x.dev/a",
    });
    expect(parseInline("<https://x.dev>")[0]).toMatchObject({ kind: "link" });
    expect(parseInline("see https://x.dev/a, then")[1]).toMatchObject({
      kind: "link",
      href: "https://x.dev/a",
    });
  });

  it("refuses to link a non-http scheme, keeping the label as text", () => {
    const nodes = parseInline("[click](javascript:alert(1))");
    expect(nodes.every((n) => n.kind === "text")).toBe(true);
    expect(text(nodes)).toContain("click");
  });

  it("renders an image as its link", () => {
    expect(parseInline("![alt](https://x.dev/i.png)")[0]).toMatchObject({
      kind: "link",
      href: "https://x.dev/i.png",
    });
  });

  it("consumes an unclosed delimiter run whole rather than rescanning it", () => {
    // Each of these used to be re-examined from every position inside the run.
    for (const source of ["`".repeat(20_000), "*".repeat(20_000), "[".repeat(20_000)]) {
      const started = Date.now();
      const nodes = parseInline(source);
      expect(text(nodes), source[0]).toBe(source);
      expect(Date.now() - started, source[0]).toBeLessThan(250);
    }
  });

  it("leaves unmatched punctuation alone", () => {
    expect(text(parseInline("a * b ** c ` d [e"))).toBe("a * b ** c ` d [e");
  });
});

describe("looksLikeMarkdown", () => {
  it("is true for the constructs worth a parse", () => {
    for (const sample of [
      "# heading",
      "- item",
      "1. item",
      "text with `code`",
      "**bold**",
      "```\nfence\n```",
      "[link](https://x.dev)",
    ]) {
      expect(looksLikeMarkdown(sample), sample).toBe(true);
    }
  });

  it("is false for plain prose", () => {
    expect(looksLikeMarkdown("Just a sentence about ses_1k0m and files.")).toBe(false);
  });
});
