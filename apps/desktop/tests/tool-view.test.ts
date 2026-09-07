import { describe, expect, it } from "vitest";
import { describeTool, relativeTo, toolNames } from "../src/tool-view.js";

describe("shell calls", () => {
  it("reads a Claude Bash call, keeping its description", () => {
    // packages/driver/src/claude.ts passes the Anthropic block through.
    const card = describeTool("tool_call", {
      id: "toolu_1",
      name: "Bash",
      args: { command: "git status --short", description: "Show working tree status" },
    });
    expect(card).toMatchObject({
      name: "Bash",
      shell: true,
      preview: "git status --short",
      caption: "Show working tree status",
      body: { kind: "shell", text: "git status --short" },
    });
  });

  it("reads a Codex command call, whose argv sits at the top level", () => {
    // packages/driver/src/codex.ts: {id, name: "command", command}
    const card = describeTool("tool_call", {
      id: "item_1",
      name: "command",
      command: ["bash", "-lc", "ls -a"],
    });
    expect(card.shell).toBe(true);
    expect(card.body).toEqual({ kind: "shell", text: "bash -lc ls -a" });
  });

  it("previews a script by its first line, keeping every line in the body", () => {
    const card = describeTool("tool_call", {
      name: "Bash",
      args: { command: "cd /tmp && # go\n  ls -a\n  pwd" },
    });
    expect(card.preview).toBe("cd /tmp && # go +2 lines");
    expect(card.body).toEqual({ kind: "shell", text: "cd /tmp && # go\n  ls -a\n  pwd" });
  });
});

describe("file calls", () => {
  it("renders Windows paths relative to the active project", () => {
    expect(
      relativeTo(
        "C:\\Users\\noku\\projects\\daydream\\apps\\web\\src\\styles.css",
        "C:\\Users\\noku\\projects\\daydream",
      ),
    ).toBe("apps/web/src/styles.css");
  });

  it("shows a write as code in the language of its path", () => {
    const card = describeTool("tool_call", {
      name: "Write",
      args: { file_path: "/repo/src/a.py", content: "def go():\n  pass" },
    });
    expect(card).toMatchObject({
      preview: "/repo/src/a.py",
      caption: "/repo/src/a.py",
      body: { kind: "code", lang: "python" },
      shell: false,
    });
  });

  it("shows a read as its path alone: the file arrives in the result", () => {
    const card = describeTool("tool_call", {
      name: "Read",
      args: { file_path: "/repo/README.md" },
    });
    expect(card.preview).toBe("/repo/README.md");
    expect(card.body).toEqual({ kind: "empty" });
  });

  it("previews a search by its query, not by its whole argument object", () => {
    const card = describeTool("tool_call", {
      name: "Grep",
      args: { pattern: "TODO", path: "/repo", output_mode: "content" },
    });
    expect(card.preview).toBe("TODO · /repo");
    expect(card.body).toMatchObject({ kind: "code", lang: "json" });
  });

  it("falls back to pretty json for a tool it does not know", () => {
    const card = describeTool("tool_call", { name: "Weird", args: { a: 1 } });
    expect(card.body).toEqual({ kind: "code", lang: "json", text: '{\n  "a": 1\n}' });
  });

  it("turns Codex file changes into a readable file list", () => {
    const card = describeTool("tool_call", {
      id: "item_29",
      name: "file_change",
      changes: [
        { path: "C:\\repo\\src\\a.ts", kind: "update" },
        { path: "C:\\repo\\src\\b.ts", kind: "update" },
      ],
      status: "completed",
    });

    expect(card).toMatchObject({
      name: "file_change",
      preview: "2 files updated",
      body: {
        kind: "files",
        changes: [
          { path: "C:\\repo\\src\\a.ts", kind: "update" },
          { path: "C:\\repo\\src\\b.ts", kind: "update" },
        ],
      },
    });
    expect(card.body.kind === "files" && card.body.text).toContain('"status": "completed"');
  });
});

describe("results", () => {
  it("names a Claude result by joining its call id", () => {
    // The Claude result block carries `toolCallId` and no name at all.
    const names = toolNames([
      { type: "tool_call", payload: { id: "toolu_1", name: "Bash", args: { command: "ls" } } },
    ]);
    const card = describeTool("tool_result", { toolCallId: "toolu_1", result: "a\nb" }, names);
    expect(card.name).toBe("Bash");
    expect(card.shell).toBe(true);
  });

  it("falls back to a generic name when the id is unknown", () => {
    expect(describeTool("tool_result", { toolCallId: "gone", result: "x" }).name).toBe(
      "result",
    );
  });

  it("flattens SDK content blocks", () => {
    const card = describeTool("tool_result", {
      toolCallId: "t",
      result: [{ type: "text", text: "one" }, { type: "image" }],
    });
    expect(card.body).toEqual({ kind: "output", text: "one\n[image]" });
  });

  it("strips escape codes from the preview but keeps them in the body", () => {
    const esc = String.fromCharCode(27);
    const card = describeTool("tool_result", { result: `${esc}[32mok${esc}[0m done` });
    expect(card.preview).toBe("ok done");
    expect(card.body).toEqual({ kind: "output", text: `${esc}[32mok${esc}[0m done` });
  });

  it("does not count a trailing newline as another line", () => {
    expect(describeTool("tool_call", { name: "Bash", args: { command: "ls\n" } }).preview).toBe(
      "ls",
    );
    expect(
      describeTool("tool_call", { name: "Bash", args: { command: "ls\nps\n" } }).preview,
    ).toBe("ls +1 line");
  });

  it("says (no output) for a result that is only terminal chrome", () => {
    const card = describeTool("tool_result", { result: "\u001B[2J\u001B[H" });
    expect(card.preview).toBe("(no output)");
    expect(card.body).toEqual({ kind: "empty" });
  });

  it("never clamps between the halves of a surrogate pair", () => {
    const card = describeTool("tool_result", { result: `${"a".repeat(159)}😀 tail` });
    expect(card.preview.endsWith("…")).toBe(true);
    expect(/[\uD800-\uDBFF]…$/.test(card.preview)).toBe(false);
  });

  it("counts the remaining lines in the preview", () => {
    const card = describeTool("tool_result", { result: "first\nsecond\nthird" });
    expect(card.preview).toBe("first +2 lines");
  });

  it("says so when a command printed nothing", () => {
    const card = describeTool("tool_result", { result: "   " });
    expect(card.preview).toBe("(no output)");
    expect(card.body).toEqual({ kind: "empty" });
  });

  it("surfaces a non-zero exit code and a failed status", () => {
    expect(
      describeTool("tool_result", { name: "command", output: "boom", exitCode: 2 }).caption,
    ).toBe("exit 2");
    expect(
      describeTool("tool_result", { name: "Bash", result: "boom", isError: true }).caption,
    ).toBe("failed");
    expect(describeTool("tool_result", { name: "Bash", result: "ok", exitCode: 0 }).caption).toBe(
      null,
    );
  });

  it("keeps an unreadable result as json rather than dropping it", () => {
    const card = describeTool("tool_result", { toolCallId: "t", meta: { n: 1 } });
    expect(card.body).toMatchObject({ kind: "code", lang: "json" });
    expect(card.body.kind === "code" && card.body.text).toContain('"n": 1');
  });
});

describe("errors", () => {
  it("renders the mock driver's tool_error as output", () => {
    const card = describeTool("tool_error", { name: "nope", error: "unknown tool" });
    expect(card).toMatchObject({
      name: "nope",
      preview: "unknown tool",
      body: { kind: "output", text: "unknown tool" },
    });
  });
});

describe("toolNames", () => {
  it("indexes only calls that carry both an id and a name", () => {
    const names = toolNames([
      { type: "tool_call", payload: { id: "a", name: "Bash" } },
      { type: "tool_call", payload: { name: "NoId" } },
      { type: "tool_result", payload: { id: "b", name: "Ignored" } },
    ]);
    expect([...names]).toEqual([["a", "Bash"]]);
  });
});
