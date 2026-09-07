/**
 * Journal tool payloads → what the transcript should show.
 *
 * Every driver shapes these differently and none of them is going to change
 * for us: Claude passes the Anthropic block through (`{id, name, args}`, and a
 * result that carries only `toolCallId`, no name), Codex synthesizes
 * `{name: "command", command}` with the command at the top level, the mock
 * uses `{name, args}`. Rather than teach the renderer all three, the variance
 * is resolved here, in a module with no DOM in it, so the cases have tests.
 *
 * The payoff is that a shell call can be recognised as a shell call — which is
 * what lets it render as a highlighted command line instead of a JSON blob.
 */
import { langOfPath, stripAnsi, type Language } from "./highlight.js";

export type ToolBody =
  | { kind: "shell"; text: string }
  | { kind: "code"; lang: Language; text: string }
  | { kind: "output"; text: string }
  | { kind: "files"; changes: readonly ToolFileChange[]; text: string }
  | { kind: "empty" };

export interface ToolFileChange {
  readonly path: string;
  readonly kind: string;
}

export interface ToolCard {
  /** Tool name for the row label: "Bash", "Read", "command". */
  readonly name: string;
  /** The one thing worth reading on the collapsed row. */
  readonly preview: string;
  /** Secondary line inside the opened row: a path, a model's own description. */
  readonly caption: string | null;
  readonly body: ToolBody;
  /** A shell call gets terminal chrome; the row also colours by it. */
  readonly shell: boolean;
}

/** Names a shell tool goes by across drivers and MCP servers. */
const SHELL_NAMES = new Set([
  "bash",
  "sh",
  "shell",
  "zsh",
  "command",
  "run_command",
  "run_terminal_cmd",
  "execute_command",
  "terminal",
  "exec",
]);

const PATH_KEYS = ["file_path", "filePath", "path", "notebook_path", "file"] as const;
const CONTENT_KEYS = ["content", "new_string", "newString", "text", "patch", "diff"] as const;

const BODY_MAX = 20_000;
const PREVIEW_MAX = 160;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  if (typeof value === "string") return value;
  // Codex hands over argv; Claude hands over a command line. Both display as
  // one line, and joining is close enough for something nobody re-runs.
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return value.join(" ");
  }
  return null;
}

/**
 * A tool result is a string, an SDK content-block array, or an object with the
 * output under a key. Flatten to the text a human would read.
 */
function resultText(value: unknown): string | null {
  const direct = asString(value);
  if (direct !== null) return direct;

  if (Array.isArray(value)) {
    const parts = value.map((block) => {
      const record = asRecord(block);
      if (typeof record.text === "string") return record.text;
      if (record.type === "image") return "[image]";
      return JSON.stringify(block);
    });
    return parts.join("\n");
  }

  const record = asRecord(value);
  for (const key of ["output", "stdout", "content", "text", "aggregated_output"]) {
    const found = asString(record[key]);
    if (found !== null) return found;
  }
  return null;
}

function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  // Never cut between the halves of a surrogate pair: an emoji sliced down the
  // middle renders as a replacement character.
  const high = /[\uD800-\uDBFF]/.test(text[max - 1] ?? "");
  return `${text.slice(0, high ? max - 1 : max)}…`;
}

/**
 * One line, whitespace flattened — a collapsed row has room for nothing else.
 * Escape codes are stripped here and only here: the opened body renders them
 * as colour, but on a single grey line they are just noise spelled `[32m`.
 */
function line(text: string, max = PREVIEW_MAX): string {
  const flat = stripAnsi(text).replace(/\s+/g, " ").trim();
  return clamp(flat, max);
}

/** " +3 lines", or nothing when there is only the one. */
function moreLines(count: number): string {
  return count <= 0 ? "" : ` +${count} line${count === 1 ? "" : "s"}`;
}

function json(value: unknown): string {
  const text = JSON.stringify(value ?? null, null, 2);
  return text === undefined ? String(value) : text;
}

function isShellName(name: string): boolean {
  return SHELL_NAMES.has(name.toLowerCase());
}

/** The command a shell call ran, wherever this driver decided to put it. */
function shellCommand(payload: Record<string, unknown>): string | null {
  const args = asRecord(payload.args);
  return (
    asString(args.command) ??
    asString(args.cmd) ??
    asString(args.script) ??
    asString(payload.command) ??
    null
  );
}

function pathOf(args: Record<string, unknown>): string | null {
  for (const key of PATH_KEYS) {
    const value = asString(args[key]);
    if (value !== null) return value;
  }
  return null;
}

function contentOf(args: Record<string, unknown>): string | null {
  for (const key of CONTENT_KEYS) {
    const value = asString(args[key]);
    if (value !== null) return value;
  }
  return null;
}

/** A Codex `file_change` item, normalized without exposing its SDK envelope. */
function fileChanges(payload: Record<string, unknown>): ToolFileChange[] | null {
  const args = asRecord(payload.args);
  const value = payload.changes ?? args.changes;
  if (!Array.isArray(value)) return null;

  return value.flatMap((item) => {
    const change = asRecord(item);
    const path = asString(change.path);
    if (path === null) return [];
    return [{ path, kind: asString(change.kind) ?? "change" }];
  });
}

function describeFileChanges(
  name: string,
  payload: Record<string, unknown>,
  changes: readonly ToolFileChange[],
): ToolCard {
  const counts = new Map<string, number>();
  for (const change of changes) {
    const kind = change.kind.toLowerCase();
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }

  const total = changes.length;
  const only = counts.size === 1 ? [...counts.keys()][0] : undefined;
  const action =
    only === "update"
      ? "updated"
      : only === "add" || only === "create"
        ? "added"
        : only === "delete" || only === "remove"
          ? "deleted"
          : "changed";

  return {
    name,
    preview: total === 0 ? "No files changed" : `${total} file${total === 1 ? "" : "s"} ${action}`,
    caption: null,
    body: { kind: "files", changes, text: clamp(json(payload), BODY_MAX) },
    shell: false,
  };
}

function describeCall(name: string, payload: Record<string, unknown>): ToolCard {
  const command = shellCommand(payload);
  if (command !== null) {
    const args = asRecord(payload.args);
    const description = asString(args.description);
    // A script previews as its first line, not as every line run together: a
    // `#` comment ends at a newline, and flattening would swallow the command
    // after it into the comment.
    // `trimEnd` first: a command almost always ends in a newline, and counting
    // that as a line claims "+1 line" for a line that is not there.
    const lines = command.trimEnd().split("\n");
    const more = moreLines(lines.length - 1);
    return {
      name,
      preview: `${line(lines[0] ?? "", PREVIEW_MAX - more.length)}${more}`,
      caption: description,
      body: { kind: "shell", text: clamp(command.trimEnd(), BODY_MAX) },
      shell: true,
    };
  }

  const changes = fileChanges(payload);
  if (changes !== null && /^(file_?change|apply_?patch)$/i.test(name)) {
    return describeFileChanges(name, payload, changes);
  }

  const args = asRecord(payload.args);
  const path = pathOf(args);
  const content = contentOf(args);

  // A search names a path too, but the pattern is the part worth reading, so
  // it has to be asked about before the path branch claims the row.
  const query = asString(args.query) ?? asString(args.pattern) ?? asString(args.prompt);
  if (query !== null) {
    return {
      name,
      preview: path === null ? line(query) : `${line(query, 96)} · ${line(path, 56)}`,
      caption: path,
      body: { kind: "code", lang: "json", text: clamp(json(args), BODY_MAX) },
      shell: false,
    };
  }

  if (path !== null) {
    // A write shows what it writes; a read shows only what it reads, because
    // the file it returns arrives in the result event a moment later.
    return {
      name,
      preview: line(path),
      caption: content === null ? null : path,
      body:
        content === null
          ? { kind: "empty" }
          : { kind: "code", lang: langOfPath(path), text: clamp(content, BODY_MAX) },
      shell: false,
    };
  }

  const rest = Object.keys(args).length > 0 ? args : payload;
  return {
    name,
    preview: line(json(rest)),
    caption: null,
    body: { kind: "code", lang: "json", text: clamp(json(rest), BODY_MAX) },
    shell: false,
  };
}

function describeResult(name: string, payload: Record<string, unknown>, shell: boolean): ToolCard {
  const text = resultText(payload.result ?? payload.output ?? payload.content ?? null);
  const exit = payload.exitCode ?? payload.exit_code;
  const failed =
    payload.isError === true ||
    payload.is_error === true ||
    payload.status === "failed" ||
    (typeof exit === "number" && exit !== 0);

  if (text === null) {
    return {
      name,
      preview: line(json(payload)),
      caption: null,
      body: { kind: "code", lang: "json", text: clamp(json(payload), BODY_MAX) },
      shell,
    };
  }

  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const first = lines[0] ?? "";
  const more = moreLines(lines.length - 1);
  // Emptiness is judged after the escape codes come off: a result that is only
  // a screen-clear has no text in it, and a blank row reads as a bug.
  const empty = stripAnsi(text).trim().length === 0;
  return {
    name,
    preview: empty ? "(no output)" : `${line(first, PREVIEW_MAX - more.length)}${more}`,
    caption:
      typeof exit === "number" && exit !== 0
        ? `exit ${exit}`
        : failed
          ? "failed"
          : null,
    body: empty ? { kind: "empty" } : { kind: "output", text: clamp(text, BODY_MAX) },
    shell,
  };
}

/**
 * `names` maps a tool-call id to the name of the call, because Claude's result
 * blocks carry the id and nothing else. Without it every result row in a
 * Claude session is labelled "result".
 */
export function describeTool(
  type: string,
  payload: unknown,
  names: ReadonlyMap<string, string> = new Map(),
): ToolCard {
  const record = asRecord(payload);
  const id = asString(record.toolCallId) ?? asString(record.id);
  const own = asString(record.name) ?? asString(record.toolName);
  const name = own ?? (id === null ? null : (names.get(id) ?? null));

  if (type === "tool_error") {
    const text = resultText(record.error) ?? asString(record.error) ?? json(record);
    return {
      name: name ?? "tool",
      preview: line(text),
      caption: null,
      body: { kind: "output", text: clamp(text, BODY_MAX) },
      shell: false,
    };
  }
  if (type === "tool_result") {
    return describeResult(name ?? "result", record, name !== null && isShellName(name));
  }
  return describeCall(name ?? "tool", record);
}

/** Ids a later result can be matched against, in journal order. */
export function toolNames(
  events: readonly { type: string; payload: unknown }[],
): Map<string, string> {
  const names = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "tool_call") continue;
    const record = asRecord(event.payload);
    const id = asString(record.id) ?? asString(record.toolCallId);
    const name = asString(record.name) ?? asString(record.toolName);
    if (id !== null && name !== null) names.set(id, name);
  }
  return names;
}

/* ==========================================================================
   What a session changed
   ========================================================================== */

/**
 * Tool names that write to the working tree. Shell is deliberately absent:
 * `bash` writes files constantly and names none of them, so guessing from a
 * command line would list paths a run only read. Git is the authority on what
 * actually changed; this is the authority on which of those changes are *this
 * session's*, and it can only be honest about the calls that name a file.
 */
const WRITE_NAMES = new Set([
  "edit",
  "write",
  "multiedit",
  "notebookedit",
  "create_file",
  "apply_patch",
  "applypatch",
  "str_replace_editor",
  "str_replace_based_edit_tool",
]);

/** The file a `tool_call` wrote, or null when the call wrote nothing. */
export function writtenPath(event: { type: string; payload: unknown }): string | null {
  if (event.type !== "tool_call") return null;
  const record = asRecord(event.payload);
  const name = asString(record.name) ?? asString(record.toolName);
  if (name === null || !WRITE_NAMES.has(name.toLowerCase())) return null;
  return pathOf(asRecord(record.args)) ?? pathOf(record);
}

/**
 * Every file this session's journal shows it writing, most recently touched
 * first, as paths relative to `root`.
 *
 * Order is by last write rather than by name: the file a run is working on now
 * is the one worth being at the top, and a session that rewrites one file
 * eleven times should still list it once.
 */
export function writtenPaths(
  events: readonly { type: string; payload: unknown }[],
  root: string,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const written = writtenPath(events[i]!);
    if (written === null) continue;
    const relative = relativeTo(written, root);
    if (seen.has(relative)) continue;
    seen.add(relative);
    out.push(relative);
  }
  return out;
}

/**
 * A tool's path argument as git would spell it. Drivers hand over absolute
 * paths; the workspace API speaks project-relative POSIX, and the two have to
 * agree or every file reads as unchanged.
 */
export function relativeTo(filePath: string, root: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (base.length > 0 && normalized.startsWith(`${base}/`)) {
    return normalized.slice(base.length + 1);
  }
  return normalized.replace(/^\.\//, "");
}
