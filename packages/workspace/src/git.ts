import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { defineConfig, field } from "@daydream-code/config";
import type { Context } from "@daydream-code/kernel";
import type {} from "@daydream-code/store";
import {
  Workspace,
  WorkspacePathError,
  type ChangedFile,
  type DiffLine,
  type FileContent,
  type FileDiff,
  type FileStatus,
  type TreeEntry,
  type WorkspaceStatus,
} from "./index.js";

const exec = promisify(execFile);

export const { Config, settings } = defineConfig({
  maxFileBytes: field.number({
    label: "file read limit",
    help: "files larger than this are clipped rather than sent whole; a 40MB fixture would stall the window.",
    default: 1024 * 1024,
    integer: true,
    min: 1024,
    unit: "bytes",
  }),
  maxEntries: field.number({
    label: "listing limit",
    help: "cap on entries returned for one directory, and on files listed as changed.",
    default: 2000,
    integer: true,
    min: 1,
    advanced: true,
  }),
  diffContext: field.number({
    label: "diff context",
    help: "unchanged lines kept around each hunk.",
    default: 3,
    integer: true,
    min: 0,
    max: 50,
    unit: "lines",
    advanced: true,
  }),
  timeoutMs: field.number({
    label: "git timeout",
    help: "a git call that outruns this is treated as a clean failure, not a hang.",
    default: 5_000,
    integer: true,
    min: 100,
    unit: "ms",
    advanced: true,
  }),
});

/** Directories never worth walking, ignored or not. */
const ALWAYS_HIDDEN = new Set([".git", ".daydream-code"]);

interface GitResult {
  ok: boolean;
  stdout: string;
}

/**
 * Default provider: the `git` CLI plus `node:fs`.
 *
 * The CLI rather than a library because it is the only implementation that
 * agrees with what the user sees in their own terminal — .gitignore
 * precedence, `core.excludesFile`, worktrees and submodules all come for free,
 * and a session's edits show up here exactly as `git status` reports them.
 *
 * Every git call degrades to "not a repo": a project opened outside version
 * control still gets a file tree, just no statuses and no diffs.
 */
export default class GitWorkspace extends Workspace {
  static inject = ["store"];
  static Config = Config;
  static settings = settings;

  readonly root: string;
  readonly #maxFileBytes: number;
  readonly #maxEntries: number;
  readonly #diffContext: number;
  readonly #timeoutMs: number;

  constructor(ctx: Context, config: z.infer<typeof Config>) {
    super(ctx);
    this.root = ctx.store.rootPath;
    this.#maxFileBytes = config.maxFileBytes;
    this.#maxEntries = config.maxEntries;
    this.#diffContext = config.diffContext;
    this.#timeoutMs = config.timeoutMs;
  }

  // -------------------------------------------------------------------------
  // Paths

  /**
   * Project-relative input to an absolute path inside the root.
   *
   * Resolution happens before any comparison, so `..` segments, absolute
   * inputs and `%2e%2e` already decoded by the transport all collapse to a
   * path that either is under the root or is rejected. `.git` and the harness
   * data directory are refused outright: they are not project content, and the
   * database file is open under one of them.
   */
  #resolve(input: string): string {
    const relative = input.replace(/^[/\\]+/, "");
    const absolute = path.resolve(this.root, relative);
    const inside =
      absolute === this.root || absolute.startsWith(this.root + path.sep);
    if (!inside) {
      throw new WorkspacePathError(input, `path escapes the project root: ${input}`);
    }
    const first = path.relative(this.root, absolute).split(path.sep)[0];
    if (first !== undefined && ALWAYS_HIDDEN.has(first)) {
      throw new WorkspacePathError(input, `path is not project content: ${input}`);
    }
    return absolute;
  }

  /** Absolute path back to the POSIX, project-relative form the API speaks. */
  #relative(absolute: string): string {
    return path.relative(this.root, absolute).split(path.sep).join("/");
  }

  // -------------------------------------------------------------------------
  // git plumbing

  async #git(args: string[], stdin?: string): Promise<GitResult> {
    try {
      const child = exec("git", args, {
        cwd: this.root,
        timeout: this.#timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        encoding: "utf8",
      });
      if (stdin !== undefined) {
        child.child.stdin?.end(stdin);
      }
      const { stdout } = await child;
      return { ok: true, stdout };
    } catch (error) {
      // A non-zero exit is an answer here, not a fault: `check-ignore` exits 1
      // for "nothing ignored" and `rev-parse` exits 128 outside a repo. The
      // partial stdout is still what the caller wanted.
      const stdout = (error as { stdout?: string }).stdout;
      return { ok: false, stdout: typeof stdout === "string" ? stdout : "" };
    }
  }

  /** NUL-separated git output, with the trailing empty field dropped. */
  static #fields(stdout: string): string[] {
    const parts = stdout.split("\0");
    if (parts[parts.length - 1] === "") parts.pop();
    return parts;
  }

  // -------------------------------------------------------------------------
  // Status

  /**
   * Branch, HEAD state and the changed-file set — no line counts.
   *
   * Separate from `status()` because counting is the expensive half (a numstat
   * over the worktree, plus a read per untracked file) and neither the tree nor
   * a single file's diff needs it. Both of those run on every click.
   */
  async #porcelain(): Promise<{
    repo: boolean;
    branch: string | null;
    unborn: boolean;
    entries: StatusEntry[];
  }> {
    const inside = await this.#git(["rev-parse", "--is-inside-work-tree"]);
    if (!inside.ok || inside.stdout.trim() !== "true") {
      return { repo: false, branch: null, unborn: false, entries: [] };
    }

    const [branchOut, headOut, porcelain] = await Promise.all([
      this.#git(["branch", "--show-current"]),
      this.#git(["rev-parse", "--verify", "--quiet", "HEAD"]),
      this.#git(["status", "--porcelain", "-z", "--untracked-files=all"]),
    ]);

    const branch = branchOut.stdout.trim();
    return {
      repo: true,
      branch: branch.length > 0 ? branch : null,
      unborn: !headOut.ok || headOut.stdout.trim().length === 0,
      entries: parseStatus(GitWorkspace.#fields(porcelain.stdout)).slice(
        0,
        this.#maxEntries,
      ),
    };
  }

  async status(): Promise<WorkspaceStatus> {
    const { repo, branch, unborn, entries } = await this.#porcelain();
    if (!repo) return { repo: false, branch: null, unborn: false, files: [] };

    // Counts come from one numstat over the whole worktree rather than one
    // diff per file: a branch with 300 changed files would otherwise be 300
    // subprocesses to draw a sidebar.
    const counts = unborn
      ? new Map<string, Counts>()
      : parseNumstat(
          GitWorkspace.#fields(
            (await this.#git(["diff", "--numstat", "-z", "HEAD"])).stdout,
          ),
        );

    const files = await Promise.all(
      entries.map(async (entry): Promise<ChangedFile> => {
        const counted = counts.get(entry.path);
        // Untracked and unborn-repo files have no HEAD side to diff against,
        // so their whole length is the addition.
        const fallback =
          counted === undefined ? await this.#countLines(entry.path) : null;
        return {
          path: entry.path,
          status: entry.status,
          ...(entry.from !== undefined ? { from: entry.from } : {}),
          added: counted?.added ?? fallback?.lines ?? 0,
          removed: counted?.removed ?? 0,
          binary: counted?.binary ?? fallback?.binary ?? false,
        };
      }),
    );

    return { repo: true, branch, unborn, files };
  }

  /** Line count for a file with no HEAD side. Never throws — 0 will do. */
  async #countLines(
    relative: string,
  ): Promise<{ lines: number; binary: boolean } | null> {
    try {
      const buffer = await fs.readFile(path.resolve(this.root, relative));
      if (isBinary(buffer)) return { lines: 0, binary: true };
      if (buffer.length === 0) return { lines: 0, binary: false };
      const text = buffer.toString("utf8");
      return {
        lines: text.split("\n").length - (text.endsWith("\n") ? 1 : 0),
        binary: false,
      };
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Tree

  async tree(dir = ""): Promise<TreeEntry[]> {
    const absolute = this.#resolve(dir);
    let raw: import("node:fs").Dirent[];
    try {
      raw = await fs.readdir(absolute, { withFileTypes: true });
    } catch (error) {
      throw new WorkspacePathError(
        dir,
        `cannot list ${dir === "" ? "the project root" : dir}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const base = this.#relative(absolute);
    const candidates = raw
      .filter((entry) => !(base === "" && ALWAYS_HIDDEN.has(entry.name)))
      // A symlink out of the tree would let the file route read anything on
      // the disk, and `#resolve` cannot catch it because the *link* is inside
      // the root. Links are simply not listed.
      .filter((entry) => entry.isDirectory() || entry.isFile())
      .map((entry) => ({
        name: entry.name,
        dir: entry.isDirectory(),
        path: base === "" ? entry.name : `${base}/${entry.name}`,
      }));

    const ignored = await this.#ignored(candidates.map((c) => c.path));
    const visible = candidates
      .filter((c) => !ignored.has(c.path))
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
      .slice(0, this.#maxEntries);

    const { entries } = await this.#porcelain();
    const status = new Map(entries.map((e) => [e.path, e.status]));

    return visible.map((entry): TreeEntry => {
      if (entry.dir) {
        const prefix = `${entry.path}/`;
        const changed = entries.some((e) => e.path.startsWith(prefix));
        return { ...entry, ...(changed ? { changed: true } : {}) };
      }
      const state = status.get(entry.path);
      return { ...entry, ...(state !== undefined ? { status: state } : {}) };
    });
  }

  /** Which of these paths git considers ignored. Empty set outside a repo. */
  async #ignored(paths: string[]): Promise<Set<string>> {
    if (paths.length === 0) return new Set();
    const result = await this.#git(
      ["check-ignore", "-z", "--stdin"],
      `${paths.join("\0")}\0`,
    );
    return new Set(GitWorkspace.#fields(result.stdout));
  }

  // -------------------------------------------------------------------------
  // File contents

  async read(relative: string): Promise<FileContent> {
    const absolute = this.#resolve(relative);
    let stat: import("node:fs").Stats;
    try {
      stat = await fs.stat(absolute);
    } catch {
      throw new WorkspacePathError(relative, `no such file: ${relative}`);
    }
    if (stat.isDirectory()) {
      throw new WorkspacePathError(relative, `${relative} is a directory`);
    }

    const handle = await fs.open(absolute, "r");
    try {
      const wanted = Math.min(stat.size, this.#maxFileBytes);
      const buffer = Buffer.alloc(wanted);
      await handle.read(buffer, 0, wanted, 0);
      const binary = isBinary(buffer);
      return {
        path: this.#relative(absolute),
        text: binary ? "" : buffer.toString("utf8"),
        bytes: stat.size,
        truncated: stat.size > wanted,
        binary,
      };
    } finally {
      await handle.close();
    }
  }

  // -------------------------------------------------------------------------
  // Diff

  async diff(relative: string): Promise<FileDiff> {
    const absolute = this.#resolve(relative);
    const target = this.#relative(absolute);
    const { repo, unborn, entries } = await this.#porcelain();
    const changed = entries.find((e) => e.path === target);

    const head: FileDiff = {
      path: target,
      status: changed?.status ?? "M",
      added: 0,
      removed: 0,
      binary: false,
      lines: [],
    };
    if (!repo || changed === undefined) return head;

    // Untracked, or a repo with no commit yet: there is no HEAD side, so the
    // file *is* the diff. Rendering it as all-adds keeps the editor's one code
    // path instead of a second "new file" mode.
    if (changed.status === "?" || unborn) {
      const content = await this.read(target);
      if (content.binary) return { ...head, binary: true };
      const lines = allAdded(content.text);
      return { ...head, added: lines.length, lines };
    }

    const [numstat, result] = await Promise.all([
      this.#git(["diff", "--numstat", "-z", "HEAD", "--", target]),
      this.#git([
        "diff",
        `--unified=${this.#diffContext}`,
        "--no-color",
        "--no-ext-diff",
        "HEAD",
        "--",
        target,
      ]),
    ]);
    const counts = parseNumstat(GitWorkspace.#fields(numstat.stdout)).get(target);
    if (counts?.binary === true) return { ...head, binary: true };
    return {
      ...head,
      added: counts?.added ?? 0,
      removed: counts?.removed ?? 0,
      lines: parseUnified(result.stdout),
    };
  }
}

// ---------------------------------------------------------------------------
// Parsers, kept free of `this` so the tests can reach them directly.

export interface StatusEntry {
  path: string;
  status: FileStatus;
  from?: string;
}

interface Counts {
  added: number;
  removed: number;
  binary: boolean;
}

/**
 * `git status --porcelain -z` fields to entries.
 *
 * Each record is `XY <path>`; a rename or copy is followed by one more field
 * holding the pre-image path. X is the index state and Y the worktree state,
 * and the pair collapses to the single letter the UI draws.
 */
export function parseStatus(fields: string[]): StatusEntry[] {
  const out: StatusEntry[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const record = fields[i];
    if (record === undefined || record.length < 4) continue;
    const index = record[0]!;
    const worktree = record[1]!;
    const filePath = record.slice(3);
    const renamed = index === "R" || index === "C";
    const from = renamed ? fields[++i] : undefined;
    out.push({
      path: filePath,
      status: collapse(index, worktree),
      ...(from !== undefined ? { from } : {}),
    });
  }
  return out;
}

function collapse(index: string, worktree: string): FileStatus {
  if (index === "?" || worktree === "?") return "?";
  if (index === "D" || worktree === "D") return "D";
  if (index === "R" || index === "C") return "R";
  if (index === "A") return "A";
  return "M";
}

/**
 * `git diff --numstat -z` fields to per-path counts.
 *
 * Normal records are one field, `added\tremoved\tpath`. Renames put an empty
 * path in that field and follow with two more fields, the old path and the
 * new; the new path is the one the rest of the API is keyed on. Binary files
 * report `-` for both counts.
 */
export function parseNumstat(fields: string[]): Map<string, Counts> {
  const out = new Map<string, Counts>();
  for (let i = 0; i < fields.length; i += 1) {
    const record = fields[i];
    if (record === undefined) continue;
    const parts = record.split("\t");
    if (parts.length < 3) continue;
    const [addedRaw, removedRaw, inline] = parts as [string, string, string];
    const filePath = inline.length > 0 ? inline : (fields[i += 2] ?? "");
    if (filePath.length === 0) continue;
    const binary = addedRaw === "-" || removedRaw === "-";
    out.set(filePath, {
      added: binary ? 0 : Number.parseInt(addedRaw, 10) || 0,
      removed: binary ? 0 : Number.parseInt(removedRaw, 10) || 0,
      binary,
    });
  }
  return out;
}

/**
 * A unified diff to flat lines carrying working-tree line numbers.
 *
 * Hunk headers are consumed rather than emitted: the editor splices these
 * lines into the file it already has, keyed on `n`, so the header's counts are
 * redundant and its text would only be one more row to style.
 */
export function parseUnified(stdout: string): DiffLine[] {
  const out: DiffLine[] = [];
  let n = 0;
  let inHunk = false;
  for (const line of stdout.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header !== null) {
      n = Number.parseInt(header[1]!, 10);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    // "\ No newline at end of file" annotates the line above it; it is not a
    // line of either side.
    if (line.startsWith("\\")) continue;
    if (line.startsWith("+")) out.push({ kind: "add", n: n++, text: line.slice(1) });
    else if (line.startsWith("-")) out.push({ kind: "del", n: null, text: line.slice(1) });
    else if (line.startsWith(" ")) out.push({ kind: "ctx", n: n++, text: line.slice(1) });
    else inHunk = false;
  }
  return out;
}

/** A file with no HEAD side, as an all-additions diff. */
function allAdded(text: string): DiffLine[] {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map((text, i) => ({ kind: "add" as const, n: i + 1, text }));
}

/**
 * A NUL in the first few KB is the same heuristic git itself uses. Cheap, and
 * wrong only for text files that contain one — which are not text files.
 */
function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0);
}
