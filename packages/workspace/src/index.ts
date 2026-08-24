import { Service, type Context } from "@daydream-code/kernel";

declare module "@daydream-code/kernel" {
  interface Context {
    workspace: Workspace;
  }
}

/**
 * Git's porcelain status letter, collapsed to the file's *worktree* state.
 * `?` is untracked; `R` keeps the rename because the old path is worth
 * showing next to the new one.
 */
export type FileStatus = "M" | "A" | "D" | "R" | "?";

export interface TreeEntry {
  /** Project-relative POSIX path. Never absolute, never escapes the root. */
  path: string;
  name: string;
  dir: boolean;
  /** Worktree status, absent when the file matches HEAD. */
  status?: FileStatus;
  /**
   * Directories only: something below this entry is modified. The tree draws a
   * badge on collapsed folders from this, so a change three levels down is
   * visible without expanding to find it.
   */
  changed?: boolean;
}

export interface ChangedFile {
  path: string;
  status: FileStatus;
  /** Pre-rename path, present only when `status` is `R`. */
  from?: string;
  added: number;
  removed: number;
  binary: boolean;
}

export interface WorkspaceStatus {
  /** False when the project root is not inside a git work tree. */
  repo: boolean;
  /** Current branch, or null on a detached HEAD or outside a repo. */
  branch: string | null;
  /** True before the first commit: everything tracked reads as added. */
  unborn: boolean;
  files: ChangedFile[];
}

export interface FileContent {
  path: string;
  text: string;
  bytes: number;
  /** True when the read was clipped at the configured byte limit. */
  truncated: boolean;
  /** True when the bytes do not decode as text; `text` is then empty. */
  binary: boolean;
}

export type DiffKind = "ctx" | "add" | "del";

export interface DiffLine {
  kind: DiffKind;
  /**
   * Line number in the working-tree file. Null on deleted lines, which have no
   * position in the file the editor is showing — they are drawn between the
   * lines that replaced them.
   */
  n: number | null;
  text: string;
}

export interface FileDiff {
  path: string;
  status: FileStatus;
  added: number;
  removed: number;
  binary: boolean;
  /**
   * Working tree against HEAD, as flat lines rather than hunks: the editor
   * splices these into the file it already has, and a hunk header carries no
   * information the line numbers do not.
   */
  lines: DiffLine[];
}

/**
 * Exclusive seam: read-only access to the project's files and to what git says
 * has changed in them.
 *
 * Read-only on purpose. Sessions edit the working tree through their driver's
 * own tools, inside whatever sandbox the driver enforces; a write path here
 * would be a second, unsandboxed one. The harness UI needs to *show* the tree,
 * a file, and a diff — nothing more.
 *
 * Every path crossing this interface is project-relative and POSIX-separated.
 * Providers are responsible for rejecting anything that resolves outside the
 * root; callers may pass user input straight through.
 */
export abstract class Workspace extends Service {
  constructor(ctx: Context) {
    super(ctx, "workspace");
  }

  /** Absolute path of the project root these paths are relative to. */
  abstract readonly root: string;

  /** Branch and the full changed-file set, with per-file line counts. */
  abstract status(): Promise<WorkspaceStatus>;

  /**
   * One directory's children, directories first then files, each alphabetical.
   * `dir` is project-relative; "" or omitted lists the root. Ignored files are
   * filtered out — a tree that shows `node_modules` is not a tree anyone reads.
   */
  abstract tree(dir?: string): Promise<TreeEntry[]>;

  /** File contents as text, clipped at the provider's byte limit. */
  abstract read(path: string): Promise<FileContent>;

  /** Working tree against HEAD for one file. Empty `lines` when unchanged. */
  abstract diff(path: string): Promise<FileDiff>;
}

/** Thrown for a path that escapes the root, or names something unreadable. */
export class WorkspacePathError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "WorkspacePathError";
  }
}
