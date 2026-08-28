/**
 * Renderer-side view of the working tree.
 *
 * The harness does not stream file changes — the journal streams what a
 * session *did*, and git is the thing that knows what that left on disk. So
 * these hooks re-read on the same signal the transcript does: a journal frame
 * for a tool call, plus the reconnect tick. That is late by the width of one
 * tool call and never wrong, which is the right trade for a sidebar.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { JournalEvent } from "@daydream-code/shared";
import { useHarness } from "./harness.js";
import type { ChangedFile, DiffLine, OpenFile, TreeEntry, WorkspaceStatus } from "./api.js";

const EMPTY_STATUS: WorkspaceStatus = {
  repo: false,
  branch: null,
  unborn: false,
  files: [],
};

/** Tool names that mean "the working tree just moved", across drivers. */
const WRITE_TOOLS = new Set([
  "edit",
  "write",
  "multiedit",
  "notebookedit",
  "apply_patch",
  "applypatch",
  "str_replace_editor",
  "str_replace_based_edit_tool",
  "create_file",
]);

/**
 * Did this event edit a file? Shell calls are deliberately included: `git
 * checkout`, `sed -i` and a build step all move the tree, and a status that
 * ignored them would go stale for the rest of the session.
 */
function touchesFiles(event: JournalEvent): boolean {
  if (event.type !== "tool_result" && event.type !== "tool_error") return false;
  const payload =
    typeof event.payload === "object" && event.payload !== null
      ? (event.payload as Record<string, unknown>)
      : {};
  const name = String(payload.name ?? payload.toolName ?? "").toLowerCase();
  return WRITE_TOOLS.has(name) || name === "bash" || name === "shell";
}

export interface WorkspaceState {
  status: WorkspaceStatus;
  loading: boolean;
  refresh(): void;
}

const WorkspaceContext = createContext<WorkspaceState | null>(null);

/**
 * The repo's branch and changed-file set, read once for the whole window.
 *
 * A context rather than a hook per consumer because five surfaces want this
 * number — the tree, the tabs, two Changes tabs and the editor's status bar —
 * and five copies of the hook would be five `git status` calls per edit.
 *
 * Refetches are coalesced on a trailing timer: a session running `Edit` in a
 * loop would otherwise queue one `git status` per call, and only the last
 * answer is the one anybody sees.
 */
export function WorkspaceProvider(props: { children: ReactNode }): ReactNode {
  const { api, subscribe, resyncTick } = useHarness();
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    api
      .workspace()
      .then(setStatus)
      // A project outside version control answers `repo: false`; a failure
      // here means the plugin is not mounted, which reads the same way.
      .catch(() => setStatus(EMPTY_STATUS));
  }, [api]);

  const schedule = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(load, 400);
  }, [load]);

  useEffect(() => {
    load();
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [load, resyncTick]);

  useEffect(
    () =>
      subscribe((frame) => {
        if (frame.kind === "journal" && touchesFiles(frame.event)) schedule();
        // A session that just ended has stopped writing; this is the read that
        // settles the tree after a burst.
        if (frame.kind === "session" && frame.session.endedAt !== null) schedule();
      }),
    [subscribe, schedule],
  );

  const value = useMemo<WorkspaceState>(
    () => ({ status: status ?? EMPTY_STATUS, loading: status === null, refresh: load }),
    [status, load],
  );

  return (
    <WorkspaceContext.Provider value={value}>
      {props.children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace(): WorkspaceState {
  const state = useContext(WorkspaceContext);
  if (state === null) throw new Error("useWorkspace outside <WorkspaceProvider>");
  return state;
}

/** One directory's children, cached per path for the lifetime of the tree. */
export function useTree(): {
  children(dir: string): TreeEntry[] | undefined;
  load(dir: string): void;
  reload(): void;
} {
  const { api, resyncTick } = useHarness();
  const [dirs, setDirs] = useState<ReadonlyMap<string, TreeEntry[]>>(new Map());
  const pending = useRef(new Set<string>());

  const load = useCallback(
    (dir: string) => {
      if (pending.current.has(dir)) return;
      pending.current.add(dir);
      api
        .tree(dir)
        .then((entries) =>
          setDirs((prev) => new Map(prev).set(dir, entries)),
        )
        .catch(() => setDirs((prev) => new Map(prev).set(dir, [])))
        .finally(() => pending.current.delete(dir));
    },
    [api],
  );

  const reload = useCallback(() => {
    pending.current.clear();
    setDirs(new Map());
  }, []);

  useEffect(reload, [reload, resyncTick]);

  const children = useCallback((dir: string) => dirs.get(dir), [dirs]);
  return { children, load, reload };
}

/** An open file, its diff, and whichever error stopped it loading. */
export function useFile(path: string | null): {
  file: OpenFile | null;
  loading: boolean;
  error: string | null;
} {
  const { api, subscribe } = useHarness();
  const [file, setFile] = useState<OpenFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (path === null) {
      setFile(null);
      setError(null);
      return;
    }
    let stale = false;
    api
      .file(path)
      .then((next) => {
        if (stale) return;
        setFile(next);
        setError(null);
      })
      .catch((e: unknown) => {
        if (stale) return;
        setFile(null);
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      stale = true;
    };
  }, [api, path, nonce]);

  // The file on screen is one a session may be editing right now.
  useEffect(
    () =>
      subscribe((frame) => {
        if (frame.kind === "journal" && touchesFiles(frame.event)) {
          setNonce((n) => n + 1);
        }
      }),
    [subscribe],
  );

  return { file, loading: path !== null && file === null && error === null, error };
}

/** One rendered row of the editor: a file line, or a deletion between two. */
export interface EditorLine {
  kind: "ctx" | "add" | "del";
  /** Working-tree line number; null on a deleted line. */
  n: number | null;
  text: string;
}

/**
 * The file, with its deletions spliced back in.
 *
 * The diff alone would show only the hunks, and the file alone would show no
 * change at all. Walking them together gives the whole file with the removed
 * lines sitting where they used to be — which is the only view that lets you
 * read the change *and* the code around it.
 */
export function mergeDiff(text: string, diff: readonly DiffLine[]): EditorLine[] {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  if (diff.length === 0) {
    return lines.map((text, i) => ({ kind: "ctx" as const, n: i + 1, text }));
  }

  // Deleted lines have no number of their own, so they are keyed to the line
  // that follows them — the position they were removed from.
  const marks = new Map<number, "add" | "ctx">();
  const deletions = new Map<number, string[]>();
  let nextLine = 1;
  for (const line of diff) {
    if (line.n !== null) {
      marks.set(line.n, line.kind === "add" ? "add" : "ctx");
      nextLine = line.n + 1;
    } else {
      const at = deletions.get(nextLine);
      if (at === undefined) deletions.set(nextLine, [line.text]);
      else at.push(line.text);
    }
  }

  const out: EditorLine[] = [];
  const flush = (at: number): void => {
    for (const text of deletions.get(at) ?? []) {
      out.push({ kind: "del", n: null, text });
    }
    deletions.delete(at);
  };
  for (let i = 0; i < lines.length; i += 1) {
    const n = i + 1;
    flush(n);
    out.push({ kind: marks.get(n) === "add" ? "add" : "ctx", n, text: lines[i]! });
  }
  // Lines deleted off the end of the file have no follower to sit before.
  for (const at of [...deletions.keys()].sort((a, b) => a - b)) flush(at);
  return out;
}
