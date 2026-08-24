/**
 * The sidebar in Code mode: the project's files, with what git says about them.
 *
 * Lazy by directory. A repo the size of a monorepo has six figures of files and
 * nobody wants a tree that stalls the window to show you three of them, so a
 * folder is listed when it is opened and never before. Folders holding a change
 * are marked even while closed — the whole reason to open this panel after a
 * run is to find what moved.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useHarness } from "../harness.js";
import { bridge } from "../bridge.js";
import { useTree, useWorkspace } from "../workspace.js";
import type { TreeEntry } from "../api.js";

/** Directories that are opened for you, because the answer is always inside. */
const AUTO_OPEN = new Set(["src", "packages", "apps", "lib", "app"]);

interface Row {
  entry: TreeEntry;
  depth: number;
  open: boolean;
}

export function FileTree(): ReactNode {
  const { file, openFile } = useHarness();
  const { children, load } = useTree();
  const { status } = useWorkspace();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  // The root is always listed; everything below it waits to be asked for.
  useEffect(() => {
    load("");
    for (const dir of expanded) load(dir);
  }, [load, expanded]);

  // One shallow auto-expand, so the panel does not open on a row of folders.
  const root = children("");
  useEffect(() => {
    if (root === undefined) return;
    const wanted = root.filter((e) => e.dir && AUTO_OPEN.has(e.name)).map((e) => e.path);
    if (wanted.length === 0) return;
    setExpanded((prev) => {
      if (wanted.every((path) => prev.has(path))) return prev;
      return new Set([...prev, ...wanted]);
    });
  }, [root]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (dir: string, depth: number): void => {
      for (const entry of children(dir) ?? []) {
        const open = entry.dir && expanded.has(entry.path);
        out.push({ entry, depth, open });
        if (open) walk(entry.path, depth + 1);
      }
    };
    walk("", 0);
    return out;
  }, [children, expanded]);

  const toggle = (path: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const openMenu = (entry: TreeEntry, open: boolean): void => {
    void bridge()
      ?.showCodeContextMenu({
        kind: "file",
        path: entry.path,
        dir: entry.dir,
        ...(entry.dir ? { expanded: open } : {}),
      })
      .then((action) => {
        if (action === "toggle" && entry.dir) toggle(entry.path);
        if (action === "open" && !entry.dir) openFile(entry.path);
      });
  };

  return (
    <div className="rail">
      <header className="rail-head">
        project
        <span className="rail-count">
          {status.files.length > 0
            ? `${status.files.length} changed`
            : status.repo
              ? "clean"
              : "no repo"}
        </span>
      </header>

      <div className="tree">
        {root === undefined && (
          <div aria-busy="true" style={{ padding: "0 12px" }}>
            <div className="skeleton skeleton-row" />
            <div className="skeleton skeleton-row" style={{ opacity: 0.5 }} />
          </div>
        )}
        {rows.map(({ entry, depth, open }) => (
          <button
            type="button"
            key={entry.path}
            className="tree-row"
            aria-current={entry.path === file}
            style={{ paddingLeft: 8 + depth * 13 }}
            title={entry.path}
            onClick={() => (entry.dir ? toggle(entry.path) : openFile(entry.path))}
            onContextMenu={(event) => {
              if (bridge() === undefined) return;
              event.preventDefault();
              openMenu(entry, open);
            }}
          >
            <span className="tree-caret" aria-hidden="true">
              {entry.dir ? (open ? "▾" : "▸") : ""}
            </span>
            <span
              className={`tree-icon${entry.dir ? " is-dir" : ""}`}
              aria-hidden="true"
            />
            <span className="tree-name">{entry.name}</span>
            {entry.status !== undefined && (
              <span className={`tree-badge change-${entry.status}`}>
                {entry.status}
              </span>
            )}
            {entry.changed === true && !open && (
              <span className="tree-dot" aria-label="contains changes" />
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
