/**
 * Switching projects: a popover under the toolbar title, and the row component
 * the first-run picker renders too.
 *
 * The app holds exactly one project at a time, so switching sits a level above
 * the workspace rather than inside it. A popover is the Mac answer to that
 * (Xcode's scheme menu, Finder's path control): it drops from the thing it
 * describes and never covers the three panes, which a full screen would.
 *
 * The list is a switcher, not a dashboard. It ranks by recency, filters as you
 * type, and moves on Enter. The facts on each row are there to help you
 * recognize the project you mean, not to be read as a status board.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { bridge, type ProjectSummary } from "../bridge.js";
import { displayParent, projectActivityAt, projectFacts, rankProjects } from "../projects.js";
import { useWorkspace } from "../workspace.js";
import { fmtAgo, fmtDateTime } from "../ui.js";

interface ProjectListState {
  home: string;
  projects: ProjectSummary[];
  loaded: boolean;
}

const EMPTY: ProjectListState = { home: "", projects: [], loaded: false };

/**
 * Load the registry with its per-project facts. `nonce` re-reads: the numbers
 * move while the app is open, so the popover asks again every time it opens
 * rather than showing what was true when the window booted.
 */
export function useProjectList(nonce: unknown = 0): ProjectListState {
  const [state, setState] = useState<ProjectListState>(EMPTY);

  useEffect(() => {
    const b = bridge();
    if (b === undefined || typeof b.listProjects !== "function") return;
    let stale = false;
    void b
      .listProjects()
      .then((list) => {
        if (stale) return;
        setState({ home: list.home, projects: list.projects, loaded: true });
      })
      .catch(() => {
        // A main process that cannot read the registry still gets a working
        // "Open project folder…"; an error bar here would be noise.
        if (!stale) setState((prev) => ({ ...prev, loaded: true }));
      });
    return () => {
      stale = true;
    };
  }, [nonce]);

  return state;
}

/**
 * One project, in the popover and on the picker. Two lines: the name you think
 * in, and the facts that separate two folders with the same name. The time is
 * the value the list sorted on, so the order always explains itself.
 *
 * The checkmark sits in a leading gutter that every row reserves, checked or
 * not, because that is where the platform puts state in a menu and because it
 * keeps the names on one optical margin. It marks the open project on its own:
 * tinting the name as well would spend the one colour the row has on a fact
 * the glyph already carries, and a coloured name in a list reads as a link.
 */
export function ProjectRow(props: {
  project: ProjectSummary;
  home: string;
  opening: boolean;
  active?: boolean;
  /** Keyboard cursor. Distinct from `active`, which means "this is the one open". */
  highlighted?: boolean;
  onOpen(rootPath: string): void;
  onHover?: (() => void) | undefined;
}): ReactNode {
  const { project, home } = props;
  const isCurrent = props.active ?? project.active;
  const facts = [displayParent(project.rootPath, home), ...projectFacts(project)];
  const when = projectActivityAt(project);

  return (
    <button
      type="button"
      className={
        "proj-row" +
        (isCurrent ? " proj-row-current" : "") +
        (props.highlighted === true ? " proj-row-cursor" : "") +
        (project.exists ? "" : " proj-row-missing")
      }
      disabled={props.opening || !project.exists}
      aria-current={isCurrent ? "true" : undefined}
      onMouseEnter={props.onHover}
      onClick={() => props.onOpen(project.rootPath)}
      title={project.rootPath}
    >
      <span className="proj-check" aria-hidden="true">
        {isCurrent && (
          <svg viewBox="0 0 10 10" width="10" height="10" focusable="false">
            <path
              d="M1.6 5.3 3.9 7.6 8.4 2.6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </span>
      <span className="proj-row-text">
        <span className="proj-name">{project.name}</span>
        <span className="proj-meta">{facts.join(" · ")}</span>
      </span>
      <span
        className="proj-when"
        title={`last active ${fmtDateTime(when)}`}
      >
        {props.opening ? "opening…" : fmtAgo(when)}
      </span>
    </button>
  );
}

export function ProjectSwitcher(props: {
  /** Name of the open project, shown on the trigger. */
  name: string;
  rootPath: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  opening: string | null;
  error: string | null;
  onOpen(rootPath: string): void;
  onPick(): void;
}): ReactNode {
  const { open, onOpenChange } = props;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [nonce, setNonce] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const { home, projects, loaded } = useProjectList(nonce);
  const branch = useWorkspace().status.branch;

  // Re-read on every open: sessions have run since the last time.
  useEffect(() => {
    if (open) setNonce((n) => n + 1);
    else setQuery("");
  }, [open]);

  const rows = useMemo(() => rankProjects(projects, query), [projects, query]);

  useEffect(() => setActive(0), [query, open]);

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const onDown = (event: MouseEvent): void => {
      const root = rootRef.current;
      if (root !== null && event.target instanceof Node && !root.contains(event.target)) {
        onOpenChange(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, onOpenChange]);

  const choose = useCallback(
    (project: ProjectSummary | undefined) => {
      if (project === undefined || !project.exists) return;
      onOpenChange(false);
      // Choosing the project already open is a no-op, not a reboot of the
      // harness: disposing and re-booting the core would drop every websocket
      // and lose nothing but time.
      if (!project.active) props.onOpen(project.rootPath);
    },
    [onOpenChange, props],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onOpenChange(false);
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (rows.length === 0) return;
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setActive((i) => (i + delta + rows.length) % rows.length);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        choose(rows[active]);
      }
    },
    [rows, active, choose, onOpenChange],
  );

  return (
    <div className="proj-select" ref={rootRef}>
      <button
        type="button"
        className="title-trigger"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => onOpenChange(!open)}
        title={`${props.rootPath}\nSwitch project (⌘⇧O)`}
      >
        <span className="proj-glyph" aria-hidden="true">
          {props.name.slice(0, 1).toUpperCase()}
        </span>
        <span className="title-text">
          <span className="title-name">{props.name}</span>
          {/* The branch, not the path: the path is fixed for the life of the
              window and the branch is the thing that changes under you while a
              run works. The path is still one hover away. */}
          <span className="title-sub">{branch ?? props.rootPath}</span>
        </span>
        <span className="title-caret" aria-hidden="true">
          <svg viewBox="0 0 10 10" width="9" height="9" focusable="false">
            <path
              d="M2.4 4 5 6.6 7.6 4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>

      {open && (
        <div
          className="proj-pop"
          role="dialog"
          aria-label="Switch project"
          onKeyDown={onKeyDown}
        >
          {/*
            * Always present, even over three rows. It is what holds keyboard
            * focus, so arrows and Enter work the moment the popover opens; a
            * field that appeared only past some count would make the keyboard
            * path depend on how many projects you happen to have.
            */}
          <div className="proj-search">
            <svg
              className="proj-search-glyph"
              viewBox="0 0 12 12"
              width="12"
              height="12"
              aria-hidden="true"
              focusable="false"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            >
              <circle cx="5" cy="5" r="3.4" />
              <path d="M7.6 7.6 10.6 10.6" />
            </svg>
            <input
              ref={searchRef}
              type="text"
              placeholder="Filter projects"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="proj-list">
            {rows.map((project, i) => (
              <ProjectRow
                key={project.rootPath}
                project={project}
                home={home}
                opening={props.opening === project.rootPath}
                highlighted={i === active}
                onHover={() => setActive(i)}
                onOpen={() => choose(project)}
              />
            ))}
            {loaded && rows.length === 0 && (
              <div className="proj-empty">
                {projects.length === 0
                  ? "No projects yet. Open a folder to start one."
                  : `Nothing matches “${query}”`}
              </div>
            )}
          </div>
          {props.error !== null && <div className="proj-error">{props.error}</div>}
          <div className="proj-foot">
            <button
              type="button"
              className="proj-open"
              onClick={() => {
                onOpenChange(false);
                props.onPick();
              }}
            >
              Open project folder…
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Keyboard path for the switcher. ⌘⇧O rather than ⌘O: this opens a project
 * that is already known, and ⌘O is the folder dialog's shortcut everywhere
 * else on the platform, which the popover's own footer button is.
 */
export function useSwitcherHotkey(toggle: () => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey) return;
      if (event.key.toLowerCase() !== "o") return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);
}
