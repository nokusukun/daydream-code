/**
 * The Changes tab: which files this thread left different from HEAD.
 *
 * Two scopes, one component. On the master thread it is the working tree —
 * everything every run has done, which is what you would see in a terminal. On
 * a run it is the intersection of two sources: the files that run's journal
 * shows it writing, and what git says is actually different now. Neither alone
 * is the answer — the journal knows *who*, git knows *whether* — so a file the
 * run wrote and then reverted correctly drops off the list.
 */
import { useMemo, type ReactNode } from "react";
import { useHarness } from "../harness.js";
import { useWorkspace } from "../workspace.js";
import type { ChangedFile, FileStatus } from "../api.js";

/** Bar widths, scaled against the biggest change in the list, not absolutely. */
const BAR_MAX = 64;

/**
 * The letter git prints, as a word.
 *
 * The badge itself is `aria-hidden`, so without this the row announces a path
 * and two numbers and never says what happened to the file.
 */
function statusWord(status: FileStatus): string {
  const words: Record<FileStatus, string> = {
    M: "modified",
    A: "added",
    D: "deleted",
    R: "renamed",
    "?": "untracked",
  };
  return words[status];
}

export function ChangesView(props: {
  /**
   * Restrict to these paths, in this order. Omitted for the whole worktree.
   */
  paths?: readonly string[] | undefined;
  /** What the list is of, said in one line under it. */
  note: ReactNode;
}): ReactNode {
  const { openFile } = useHarness();
  const { status, loading } = useWorkspace();

  const files = useMemo(() => {
    if (props.paths === undefined) return status.files;
    const byPath = new Map(status.files.map((f) => [f.path, f]));
    return props.paths
      .map((path) => byPath.get(path))
      .filter((f): f is ChangedFile => f !== undefined);
  }, [props.paths, status.files]);

  const scale = useMemo(() => {
    const biggest = Math.max(1, ...files.map((f) => f.added + f.removed));
    return (n: number) => Math.round((n / biggest) * BAR_MAX);
  }, [files]);

  if (loading) {
    return (
      <div className="changes" aria-busy="true">
        <div className="skeleton" style={{ height: 40 }} />
        <div className="skeleton" style={{ height: 40, opacity: 0.6 }} />
      </div>
    );
  }

  if (!status.repo) {
    return (
      <div className="empty">
        <p className="empty-title">Not a git repository</p>
        <p className="empty-body">
          This project is not under version control, so there is no HEAD to
          compare against, so there is nothing to diff.
        </p>
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="empty">
        <p className="empty-title">
          {props.paths === undefined
            ? "Working tree is clean"
            : "Nothing changed on disk"}
        </p>
        <p className="empty-body">
          {props.paths === undefined
            ? `Nothing differs from HEAD${status.branch !== null ? ` on ${status.branch}` : ""}.`
            : "This thread has not written a file that still differs from HEAD."}
        </p>
      </div>
    );
  }

  return (
    <div className="changes">
      {files.map((file) => (
        <button
          type="button"
          key={file.path}
          className="change-row"
          title={`${file.path} · ${statusWord(file.status)}${
            file.from === undefined ? "" : ` from ${file.from}`
          }`}
          onClick={() => openFile(file.path)}
        >
          <span className={`change-badge change-${file.status}`} aria-hidden="true">
            {file.status}
          </span>
          <span className="change-path">{file.path}</span>
          <span className="change-bars" aria-hidden="true">
            <span className="bar-add" style={{ width: scale(file.added) }} />
            <span className="bar-del" style={{ width: scale(file.removed) }} />
          </span>
          <span className="change-stat">
            {file.binary ? (
              <i>binary</i>
            ) : (
              <>
                <span className="stat-add">+{file.added}</span>
                <span className="stat-del">−{file.removed}</span>
              </>
            )}
          </span>
          <span className="change-open">Open ↗</span>
        </button>
      ))}
      <p className="changes-note">{props.note}</p>
    </div>
  );
}
