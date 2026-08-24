/**
 * Code mode: the file a run touched, with the change still visible in it.
 *
 * Not an editor — nothing here writes. The harness's whole model is that a
 * session edits the tree through its driver's tools, inside that driver's
 * sandbox; a second, unsandboxed write path in the window would be a way to
 * make the journal lie about who changed what.
 *
 * What it is instead is a reader that shows the diff *in place*: the whole
 * file, with the removed lines put back where they were. A diff view alone
 * shows the hunks and none of the code around them, and a plain file view
 * shows the code and none of the change. Either one on its own makes you open
 * the other.
 */
import { useMemo, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { useHarness } from "../harness.js";
import { bridge, type CodeContextMenuRequest } from "../bridge.js";
import { selectionDraft } from "../code-context.js";
import { NEW_SESSION_DRAFT } from "../drafts.js";
import { mergeDiff, useFile, useWorkspace } from "../workspace.js";
import { highlightLines, langOfPath, type Token } from "../highlight.js";
import { Tokens } from "../prose.js";
import { compact } from "./ThreadRail.js";

export function CodeView(): ReactNode {
  const { openFiles, file, openFile, closeFile, setMode } = useHarness();
  const { status } = useWorkspace();
  const changed = useMemo(
    () => new Map(status.files.map((f) => [f.path, f])),
    [status.files],
  );

  return (
    <main className="editor">
      <div className="tabs">
        {openFiles.map((path) => (
          <div
            key={path}
            className={`tab${path === file ? " is-active" : ""}`}
            role="presentation"
          >
            <button
              type="button"
              className="tab-main"
              title={path}
              onClick={() => openFile(path)}
            >
              <span
                className={`tab-dot${changed.has(path) ? " is-changed" : ""}`}
                aria-hidden="true"
              />
              {path.split("/").pop()}
            </button>
            <button
              type="button"
              className="tab-close"
              aria-label={`Close ${path}`}
              onClick={() => closeFile(path)}
            >
              ×
            </button>
          </div>
        ))}
        <span className="tabs-spacer" />
        <button type="button" className="tab-back" onClick={() => setMode("agent")}>
          ← Back to thread
        </button>
      </div>

      {file === null ? (
        <div className="empty">
          <p className="empty-title">No file open</p>
          <p className="empty-body">
            Pick a file on the left, or open one from a run's Changes tab to see
            what it did to it.
          </p>
        </div>
      ) : (
        <FileBody key={file} path={file} />
      )}
    </main>
  );
}

function FileBody(props: { path: string }): ReactNode {
  const { path } = props;
  const { drafts, newSession } = useHarness();
  const { file, loading, error } = useFile(path);
  const { status } = useWorkspace();

  const lang = useMemo(() => langOfPath(path), [path]);
  const lines = useMemo(
    () => (file === null ? [] : mergeDiff(file.text, file.diff.lines)),
    [file],
  );
  // The file is tokenized whole, then cut by line: a block comment or template
  // literal has to survive being rendered one row at a time.
  const tokens = useMemo(
    () => (file === null ? [] : highlightLines(file.text, lang)),
    [file, lang],
  );
  const deleted = useMemo(() => {
    const out = new Map<string, Token[]>();
    for (const line of file?.diff.lines ?? []) {
      if (line.kind === "del" && !out.has(line.text)) {
        out.set(line.text, highlightLines(line.text, lang)[0] ?? []);
      }
    }
    return out;
  }, [file, lang]);

  const segments = path.split("/");

  const openSelectionMenu = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const selection = window.getSelection();
    if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    const common =
      range.commonAncestorContainer instanceof Element
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
    if (common === null || !event.currentTarget.contains(common)) return;
    const text = selection.toString();
    if (text.trim().length === 0) return;

    const rowOf = (node: Node | null): HTMLElement | null => {
      const element = node instanceof Element ? node : node?.parentElement;
      const row = element?.closest<HTMLElement>(".code-line") ?? null;
      return row !== null && event.currentTarget.contains(row) ? row : null;
    };
    const numberOf = (node: Node | null): number | undefined => {
      const raw = rowOf(node)?.dataset.line;
      if (raw === undefined) return undefined;
      const parsed = Number(raw);
      return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
    };
    const a = numberOf(selection.anchorNode);
    const b = numberOf(selection.focusNode);
    const request: Extract<CodeContextMenuRequest, { kind: "selection" }> = {
      kind: "selection",
      path,
      text,
      ...(a !== undefined || b !== undefined
        ? { lineStart: Math.min(a ?? b!, b ?? a!), lineEnd: Math.max(a ?? b!, b ?? a!) }
        : {}),
    };
    const appBridge = bridge();
    if (appBridge === undefined) return;
    event.preventDefault();
    void appBridge.showCodeContextMenu(request).then((action) => {
      if (action !== "ask-selection") return;
      const current = drafts.get(NEW_SESSION_DRAFT);
      const prompt = selectionDraft(request, lang);
      drafts.set(NEW_SESSION_DRAFT, {
        ...current,
        text: current.text.length > 0 ? `${current.text}\n\n${prompt}` : prompt,
      });
      newSession();
    });
  };

  return (
    <>
      <div className="crumbs">
        {segments.map((segment, i) => (
          <span key={i} className={i === segments.length - 1 ? "crumb-last" : "crumb"}>
            {segment}
            {i < segments.length - 1 && <i aria-hidden="true">›</i>}
          </span>
        ))}
      </div>

      <div className="code-scroll" onContextMenu={openSelectionMenu}>
        {loading && (
          <div aria-busy="true" style={{ padding: 20 }}>
            <div className="skeleton" style={{ height: 14, width: "40%" }} />
            <div className="skeleton" style={{ height: 14, width: "62%", opacity: 0.6 }} />
            <div className="skeleton" style={{ height: 14, width: "51%", opacity: 0.35 }} />
          </div>
        )}

        {error !== null && <div className="error-bar">{error}</div>}

        {file !== null && file.binary && (
          <div className="empty">
            <p className="empty-title">Binary file</p>
            <p className="empty-body">
              {file.bytes.toLocaleString()} bytes, not text. There is nothing to
              show line by line.
            </p>
          </div>
        )}

        {file !== null &&
          !file.binary &&
          (() => {
            // One counter walking the working-tree lines; deletions do not
            // advance it, which is what keeps the numbers matching the file on
            // disk rather than the diff.
            let contextIndex = 0;
            return lines.map((line, i) => {
              const own = line.n === null ? null : tokens[contextIndex++] ?? [];
              return (
                <div
                  className={`code-line line-${line.kind}`}
                  key={i}
                  {...(line.n === null ? {} : { "data-line": line.n })}
                >
                  <span className="code-n">{line.n ?? ""}</span>
                  <span className="code-mark" aria-hidden="true">
                    {line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}
                  </span>
                  <code className="code-text">
                    <Tokens tokens={own ?? deleted.get(line.text) ?? []} />
                  </code>
                </div>
              );
            });
          })()}

        {file !== null && file.truncated && (
          <p className="code-clip">
            Clipped at {compact(file.bytes)} bytes. The rest of the file is on
            disk.
          </p>
        )}
      </div>

      <div className="statusbar">
        <span>{lang === "text" ? "plain text" : lang}</span>
        {file !== null && !file.binary && (
          <span>{file.text.split("\n").length.toLocaleString()} lines</span>
        )}
        {file !== null && file.diff.lines.length > 0 && (
          <span className="status-stat">
            <span className="stat-add">+{file.diff.added}</span>
            <span className="stat-del">−{file.diff.removed}</span>
          </span>
        )}
        <span className="statusbar-spacer" />
        {status.branch !== null && (
          <span className="status-branch" title="Current branch">
            {status.branch}
          </span>
        )}
        <span>
          {status.files.length} changed in tree
        </span>
      </div>
    </>
  );
}
