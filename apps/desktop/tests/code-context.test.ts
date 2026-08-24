import { describe, expect, it } from "vitest";
import { selectionDraft, selectionReference } from "../src/code-context.js";

describe("code context menu", () => {
  it("labels one line and a normalized reversed range", () => {
    expect(selectionReference("src/app.ts", 8, 8)).toBe("src/app.ts:L8");
    expect(selectionReference("src/app.ts", 12, 8)).toBe("src/app.ts:L8-L12");
    expect(selectionReference("src/app.ts")).toBe("src/app.ts");
  });

  it("makes an editable task with language and source", () => {
    expect(
      selectionDraft(
        {
          kind: "selection",
          path: "src/app.ts",
          text: "const answer = 42;",
          lineStart: 3,
          lineEnd: 3,
        },
        "js",
      ),
    ).toBe(
      "Help me with this code from `src/app.ts:L3`:\n\n```js\nconst answer = 42;\n```",
    );
  });

  it("uses a longer fence when the selection already contains one", () => {
    const draft = selectionDraft(
      { kind: "selection", path: "README.md", text: "```sh\necho hi\n```" },
      "text",
    );
    expect(draft).toContain("\n\n````\n```sh\necho hi\n```\n````");
  });
});
