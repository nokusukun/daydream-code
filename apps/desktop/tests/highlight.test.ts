import { describe, expect, it } from "vitest";
import {
  hasAnsi,
  highlight,
  langOfPath,
  normalizeLang,
  parseAnsi,
  stripAnsi,
  type Token,
  type TokenKind,
} from "../src/highlight.js";

/** Every tokenizer must be lossless: the tokens rebuild the input exactly. */
function joined(tokens: Token[]): string {
  return tokens.map((t) => t.text).join("");
}

/** Runs of one kind merge, so a word arrives with its surrounding spaces. */
function kindOf(tokens: Token[], text: string): TokenKind | undefined {
  return tokens.find((t) => t.text.trim() === text)?.kind;
}

describe("normalizeLang", () => {
  it("maps aliases and falls back to text", () => {
    expect(normalizeLang("bash")).toBe("shell");
    expect(normalizeLang("TSX")).toBe("js");
    expect(normalizeLang("brainfuck")).toBe("text");
    expect(normalizeLang(null)).toBe("text");
    expect(langOfPath("src/a/b.py")).toBe("python");
    expect(langOfPath("Makefile")).toBe("text");
  });
});

describe("shell", () => {
  it("marks the command name, its flags and its strings", () => {
    const tokens = highlight("git commit -m 'first pass'", "shell");
    expect(kindOf(tokens, "git")).toBe("command");
    expect(kindOf(tokens, "commit")).toBe("plain");
    expect(kindOf(tokens, "-m")).toBe("flag");
    expect(kindOf(tokens, "'first pass'")).toBe("string");
  });

  it("puts the word after a pipe back into command position", () => {
    const tokens = highlight("cat log | grep -i error", "shell");
    expect(kindOf(tokens, "grep")).toBe("command");
    expect(kindOf(tokens, "|")).toBe("operator");
    expect(kindOf(tokens, "cat")).toBe("command");
  });

  it("keeps the command after sudo and after an env assignment", () => {
    expect(kindOf(highlight("sudo rm -rf /tmp/x", "shell"), "rm")).toBe("command");
    expect(kindOf(highlight("CI=1 pnpm test", "shell"), "pnpm")).toBe("command");
  });

  it("reads comments, variables and keywords", () => {
    const tokens = highlight("if true; then echo $HOME # why\nfi", "shell");
    expect(kindOf(tokens, "if")).toBe("keyword");
    expect(kindOf(tokens, "$HOME")).toBe("variable");
    expect(kindOf(tokens, "# why")).toBe("comment");
  });

  it("does not start a comment inside a string", () => {
    const tokens = highlight("echo 'a # b'", "shell");
    expect(tokens.some((t) => t.kind === "comment")).toBe(false);
  });

  it("does not read a flag as a flag in command position", () => {
    // `-` here is a path fragment, not an option: nothing has run yet.
    expect(kindOf(highlight("--version", "shell"), "--version")).not.toBe("flag");
  });

  it("treats a leading prompt as chrome", () => {
    const tokens = highlight("$ ls -a", "shell");
    expect(kindOf(tokens, "$")).toBe("operator");
    expect(kindOf(tokens, "ls")).toBe("command");
  });

  it("swallows a heredoc body as one string", () => {
    const tokens = highlight("cat <<EOF\n# not a comment\nEOF\nls", "shell");
    expect(tokens.some((t) => t.kind === "comment")).toBe(false);
    expect(kindOf(tokens, "ls")).toBe("command");
  });

  it("does not lose an unterminated quote", () => {
    const source = "echo 'oops";
    expect(joined(highlight(source, "shell"))).toBe(source);
  });
});

describe("other grammars", () => {
  it("tokenizes js", () => {
    const tokens = highlight("const n = fn(1); // note", "js");
    expect(kindOf(tokens, "const")).toBe("keyword");
    expect(kindOf(tokens, "fn")).toBe("command");
    expect(kindOf(tokens, "1")).toBe("number");
    expect(kindOf(tokens, "// note")).toBe("comment");
  });

  it("separates json keys from string values", () => {
    const tokens = highlight('{"a": "b", "n": 2, "t": true}', "json");
    expect(kindOf(tokens, '"a"')).toBe("property");
    expect(kindOf(tokens, '"b"')).toBe("string");
    expect(kindOf(tokens, "2")).toBe("number");
    expect(kindOf(tokens, "true")).toBe("builtin");
  });

  it("tokenizes python and yaml", () => {
    expect(kindOf(highlight("def go(self):", "python"), "def")).toBe("keyword");
    expect(kindOf(highlight("name: value # c", "yaml"), "# c")).toBe("comment");
  });

  it("marks diff lines", () => {
    const tokens = highlight("@@ -1 +1 @@\n-old\n+new\n same\n", "diff");
    expect(tokens.map((t) => t.kind)).toEqual(["meta", "delete", "insert", "plain"]);
  });

  it("leaves unknown languages as one plain token", () => {
    expect(highlight("anything at all", "text")).toEqual([
      { kind: "plain", text: "anything at all" },
    ]);
  });

  it("is lossless for every grammar", () => {
    const source = "const x = `a ${b} c`; # ok\n- 1 + 2 | $VAR 'q\"\n";
    for (const lang of ["shell", "js", "json", "python", "yaml", "diff", "text"] as const) {
      expect(joined(highlight(source, lang)), lang).toBe(source);
    }
  });

  it("merges runs of one kind", () => {
    const tokens = highlight("a  b", "text");
    expect(tokens).toHaveLength(1);
  });
});

describe("ansi", () => {
  it("detects and strips escapes", () => {
    const source = "\u001B[31mred\u001B[0m plain\u001B[2K";
    expect(hasAnsi(source)).toBe(true);
    expect(stripAnsi(source)).toBe("red plain");
    expect(hasAnsi("plain")).toBe(false);
  });

  it("reads colour, bold and reset into spans", () => {
    const spans = parseAnsi("\u001B[1;32mok\u001B[0m fail");
    expect(spans[0]).toEqual({ text: "ok", color: 2, bold: true, dim: false });
    expect(spans[1]).toEqual({ text: " fail", color: null, bold: false, dim: false });
  });

  it("maps bright colours above the base eight", () => {
    expect(parseAnsi("\u001B[91mx")[0]!.color).toBe(9);
  });

  it("folds 256-colour and truecolor codes without leaking bytes", () => {
    expect(parseAnsi("\u001B[38;5;9mx")[0]).toMatchObject({ text: "x", color: 9 });
    expect(parseAnsi("\u001B[38;5;200mx")[0]).toMatchObject({ text: "x", color: null });
    expect(parseAnsi("\u001B[38;2;1;2;3mx")[0]).toMatchObject({ text: "x", color: null });
  });

  it("does not let a background colour repaint the text", () => {
    // 48 takes the same parameters as 38; not consuming them let a byte of a
    // truecolor background fall through and be read as a foreground code.
    expect(parseAnsi("\u001B[48;5;31mbg")[0]).toEqual({
      text: "bg",
      color: null,
      bold: false,
      dim: false,
    });
    expect(parseAnsi("\u001B[48;2;30;40;50mtc")[0]).toEqual({
      text: "tc",
      color: null,
      bold: false,
      dim: false,
    });
    // The foreground still wins when both are set.
    expect(parseAnsi("\u001B[48;5;31;32mboth")[0]).toMatchObject({ color: 2 });
  });

  it("keeps all printable text", () => {
    const source = "\u001B[36mone\u001B[39m two\nthree";
    expect(parseAnsi(source).map((s) => s.text).join("")).toBe("one two\nthree");
  });
});
