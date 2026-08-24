import Database from "better-sqlite3";
const db = new Database("/tmp/dd-preview/.daydream-code/store.sqlite");
const sid = db.prepare("select id from sessions limit 1").get().id;
const ins = db.prepare(
  "insert into journal_events (session_id, ts, type, payload_json) values (?, ?, ?, ?)",
);
let t = Date.parse("2026-08-23T15:40:00Z");
const add = (type, payload) => {
  t += 4000;
  ins.run(sid, new Date(t).toISOString(), type, JSON.stringify(payload));
};
const E = String.fromCharCode(27);

add("session_started", { driver: "claude", resumed: false });
add("context_assembled", {
  model: "claude-opus-4-20250514",
  tools: ["Bash", "Read", "Edit", "Write", "Grep", "Glob"],
});

add("turn", {
  text: `## What I changed

The transcript now renders **markdown** and highlights code. Two new modules do the work:

- \`markdown.ts\` — a CommonMark subset that parses to *nodes*, never to HTML
- \`highlight.ts\` — one tokenizer per language, plus an SGR reader for ANSI

| module | lines | tested by |
| :-- | --: | :-- |
| markdown.ts | 341 | 22 cases |
| highlight.ts | 331 | 22 cases |
| tool-view.ts | 218 | 16 cases |

Run it yourself:

\`\`\`sh
# the whole suite, not just the new files
CI=1 pnpm test --reporter=dot && echo "green" || echo "red"
\`\`\`

The renderer maps a token kind to a class:

\`\`\`ts
const spans = tokens.map((token, i) =>
  token.kind === "plain" ? token.text : <span className={\`t-\${token.kind}\`}>{token.text}</span>,
);
\`\`\`

> Nothing here builds a string of HTML — see [the note](https://commonmark.org) on why.

Next: the CLI printer. Meanwhile \`snake_case_names\` stay upright and 2 * 3 * 4 is arithmetic.`,
});

add("thinking", {
  text: "The result rows carry only a call id, so the name has to come from the call that opened it.",
});

add("tool_call", {
  id: "t1",
  name: "Bash",
  args: { command: "git status --short | head -20", description: "Show working tree status" },
});
add("tool_result", {
  toolCallId: "t1",
  result: `${E}[32m M${E}[0m apps/desktop/src/styles.css\n${E}[32m??${E}[0m apps/desktop/src/markdown.ts\n${E}[32m??${E}[0m apps/desktop/src/highlight.ts`,
});

add("tool_call", {
  id: "t2",
  name: "Bash",
  args: {
    command:
      'for f in $(ls apps/desktop/src/*.ts); do\n  # count what landed\n  echo "$f: $(wc -l < "$f")"\ndone',
    description: "Count the new module lines",
  },
});
add("tool_result", {
  toolCallId: "t2",
  result:
    "apps/desktop/src/highlight.ts: 331\napps/desktop/src/markdown.ts: 341\napps/desktop/src/tool-view.ts: 218",
});

add("tool_call", {
  id: "t3",
  name: "Bash",
  args: { command: "npx vitest run apps/desktop/tests/", description: "Run the desktop tests" },
});
add("tool_result", {
  toolCallId: "t3",
  result: `${E}[32m ✓${E}[39m apps/desktop/tests/markdown.test.ts ${E}[2m(22 tests)${E}[22m 5ms\n${E}[32m ✓${E}[39m apps/desktop/tests/highlight.test.ts ${E}[2m(22 tests)${E}[22m 6ms\n\n${E}[1m${E}[32m Test Files ${E}[39m${E}[22m 6 passed (6)\n${E}[1m${E}[32m      Tests ${E}[39m${E}[22m 81 passed (81)`,
});

add("tool_call", {
  id: "t4",
  name: "Write",
  args: {
    file_path: "/repo/apps/desktop/src/prose.tsx",
    content:
      'export function Markdown(props: { text: string }): ReactNode {\n  const parsed = useMemo(() => parseMarkdown(props.text), [props.text]);\n  return <div className="md">{blocks(parsed)}</div>;\n}',
  },
});
add("tool_result", {
  toolCallId: "t4",
  result: "File created successfully at /repo/apps/desktop/src/prose.tsx",
});

add("tool_call", {
  id: "t5",
  name: "Grep",
  args: { pattern: "dangerouslySetInnerHTML", path: "/repo/apps", output_mode: "content" },
});
add("tool_result", { toolCallId: "t5", result: "" });

add("tool_call", {
  id: "t6",
  name: "Bash",
  args: { command: "npx tsc -b --force", description: "Typecheck the whole build" },
});
add("tool_result", {
  toolCallId: "t6",
  result: `${E}[31mapps/desktop/src/prose.tsx(64,12): error TS2304: Cannot find name 'Fence'.${E}[0m`,
  isError: true,
});

add("tool_error", { name: "Bash", error: "Command timed out after 120s" });

add("turn_end", {});

add("user_injected", {
  text: "Nice — now check the *light* theme too, and make sure `--syn-*` clears AA.",
});

add("turn", {
  text: "Checked both themes. Light drops each hue to ~48% lightness, which clears AA on `--code-surface`.",
});

add("session_ended", { status: "completed" });

db.prepare("update sessions set status='completed', ended_at=? where id=?").run(
  new Date(t).toISOString(),
  sid,
);
console.log(
  "events:",
  db.prepare("select count(*) c from journal_events").get().c,
  "session:",
  sid,
);
