/**
 * The workspace. One window, one toolbar, a sidebar and a panel — no page
 * routing, because there is no second page.
 *
 * The window has two modes rather than two windows. `agent` is the harness:
 * the master thread on the left, whichever thread you picked in the middle,
 * and a box to type into. `code` is the working tree that harness is editing.
 * They swap the whole body instead of splitting it, because a 250px file tree
 * next to a 250px run list next to a transcript is three columns none of which
 * is wide enough to read.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { bridge, connectionFromQuery, type ConnectionInfo } from "./bridge.js";
import { useAppearance, type ThemeState } from "./appearance.js";
import { HarnessProvider, useHarness, type Mode } from "./harness.js";
import { WorkspaceProvider, useWorkspace } from "./workspace.js";
import { SplitPane } from "./split.js";
import { ProjectPicker } from "./views/ProjectPicker.js";
import { ProjectSwitcher, useSwitcherHotkey } from "./views/ProjectSwitcher.js";
import { ThreadRail } from "./views/ThreadRail.js";
import { FileTree } from "./views/FileTree.js";
import { MasterPanel } from "./views/MasterPanel.js";
import { SessionPanel } from "./views/SessionPanel.js";
import { CodeView } from "./views/CodeView.js";
import { ActivityMenu } from "./views/ActivityMenu.js";
import { AppMenu } from "./views/AppMenu.js";
import { CommandPalette } from "./views/CommandPalette.js";
import { FibersSheet } from "./views/FibersSheet.js";

export function App(): ReactNode {
  const [connection, setConnection] = useState<ConnectionInfo | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasBridge = bridge() !== undefined;

  const theme = useAppearance();

  useEffect(() => {
    const remote = connectionFromQuery();
    if (remote !== null) {
      setConnection(remote);
      return;
    }
    const b = bridge();
    if (b === undefined) return;
    void b.getState().then((state) => setConnection(state.connection));
    return b.onConnection((info) => {
      setConnection(info);
      setOpening(null);
      setError(null);
    });
  }, []);

  const openProject = useCallback((rootPath: string) => {
    const b = bridge();
    if (b === undefined) return;
    setOpening(rootPath);
    setError(null);
    void b.openProject(rootPath).then((result) => {
      setOpening(null);
      if (!result.ok) setError(result.error);
    });
  }, []);

  const pickProject = useCallback(() => {
    const b = bridge();
    if (b === undefined) return;
    setError(null);
    void b.pickProject().then((result) => {
      if (result !== null && !result.ok) setError(result.error);
    });
  }, []);

  if (connection === null) {
    return (
      <ProjectPicker
        opening={opening}
        error={error}
        hasBridge={hasBridge}
        onOpen={openProject}
        onPick={pickProject}
      />
    );
  }

  return (
    <HarnessProvider
      key={`${connection.url}|${connection.token}`}
      connection={connection}
    >
      <WorkspaceProvider>
        <Workspace
          theme={theme}
          switcher={
            hasBridge
              ? { opening, error, onOpen: openProject, onPick: pickProject }
              : undefined
          }
        />
      </WorkspaceProvider>
    </HarnessProvider>
  );
}

/** Everything the toolbar switcher needs, absent when there is no bridge. */
interface SwitcherProps {
  opening: string | null;
  error: string | null;
  onOpen(rootPath: string): void;
  onPick(): void;
}

const MODES: Array<[Mode, string]> = [
  ["agent", "Agent"],
  ["code", "Code"],
];

function Workspace(props: {
  theme: ThemeState;
  switcher?: SwitcherProps | undefined;
}): ReactNode {
  const {
    connection,
    selected,
    newSession,
    overlay,
    setOverlay,
    mode,
    setMode,
    sidebar,
    toggleSidebar,
  } = useHarness();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const hasSwitcher = props.switcher !== undefined;
  const toggleSwitcher = useCallback(() => {
    if (hasSwitcher) setSwitcherOpen((o) => !o);
  }, [hasSwitcher]);
  useSwitcherHotkey(toggleSwitcher);

  // App-level shortcuts, bound here rather than per-view because none of them
  // belongs to a view: ⌘K and ⌘N reach the whole window, ⌘, is the platform's
  // settings key, and ⌘⇧E is what every editor uses to get to the file tree.
  const panel =
    mode === "code" ? (
      <CodeView />
    ) : selected === null ? (
      <MasterPanel />
    ) : (
      <SessionPanel key={selected} id={selected} />
    );

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) {
        if (event.key === "Escape" && overlay !== null) setOverlay(null);
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "k") {
        event.preventDefault();
        setOverlay(overlay === "palette" ? null : "palette");
      }
      if (key === "n") {
        event.preventDefault();
        newSession();
      }
      if (key === "b") {
        event.preventDefault();
        toggleSidebar();
      }
      if (key === "e" && event.shiftKey) {
        event.preventDefault();
        setMode(mode === "code" ? "agent" : "code");
      }
      if (event.key === ",") {
        event.preventDefault();
        void bridge()?.openSettings();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overlay, setOverlay, newSession, toggleSidebar, setMode, mode]);

  return (
    <div className="app">
      <header className="toolbar glass">
        {/* The traffic lights sit in this strip under `hiddenInset`; the
            leading gap is theirs, not padding. */}
        <span className="traffic-gap" aria-hidden="true" />

        {props.switcher !== undefined ? (
          <ProjectSwitcher
            name={connection.name}
            rootPath={connection.rootPath}
            open={switcherOpen}
            onOpenChange={setSwitcherOpen}
            opening={props.switcher.opening}
            error={props.switcher.error}
            onOpen={props.switcher.onOpen}
            onPick={props.switcher.onPick}
          />
        ) : (
          <div className="title-block">
            <span className="title-name">{connection.name}</span>
            <Branch fallback={connection.rootPath} />
          </div>
        )}

        <div className="segmented segmented-mode" role="tablist" aria-label="Mode">
          {MODES.map(([value, label]) => (
            <button
              type="button"
              key={value}
              role="tab"
              aria-selected={mode === value}
              title={`${label} (⌘⇧E)`}
              onClick={() => setMode(value)}
            >
              {label}
            </button>
          ))}
        </div>

        <span className="toolbar-spacer" />
        <ActivityMenu />
        <span className="toolbar-spacer" />

        <button
          type="button"
          className="titlebar-search"
          onClick={() => setOverlay("palette")}
        >
          Search or jump to…
          <kbd>⌘K</kbd>
        </button>
        <button
          type="button"
          className="toolbar-icon"
          aria-label={props.theme.resolved === "dark" ? "Use light theme" : "Use dark theme"}
          title={`Appearance: ${props.theme.choice}`}
          onClick={props.theme.toggle}
        >
          {props.theme.resolved === "dark" ? "☀" : "☾"}
        </button>
        <button
          type="button"
          className="toolbar-icon"
          aria-pressed={sidebar}
          aria-label="Toggle sidebar"
          title="Toggle sidebar (⌘B)"
          onClick={toggleSidebar}
        >
          ▤
        </button>
        <AppMenu theme={props.theme} />
      </header>

      {/* Two ids, not one: a file tree and a run list want different widths,
          and sharing a key would make switching modes resize the other one. */}
      {sidebar ? (
        <SplitPane
          id={mode === "code" ? "shell-tree" : "shell-rail"}
          className="body"
          direction="row"
          fixed="first"
          initial={268}
          min={180}
          max={520}
          first={
            <aside className="sidebar glass">
              {mode === "agent" ? <ThreadRail /> : <FileTree />}
            </aside>
          }
          second={panel}
        />
      ) : (
        <div className="body">{panel}</div>
      )}

      {overlay === "palette" && (
        <CommandPalette
          onSwitchProject={hasSwitcher ? () => setSwitcherOpen(true) : undefined}
        />
      )}
      {overlay === "fibers" && <FibersSheet />}
    </div>
  );
}

/** The branch under the project name, or the path when there is no repo. */
function Branch(props: { fallback: string }): ReactNode {
  const { status } = useWorkspace();
  return (
    <span className="title-sub" title={props.fallback}>
      {status.branch ?? props.fallback}
    </span>
  );
}
