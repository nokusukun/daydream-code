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
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
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
import { ProjectFanoutProvider } from "./project-fanout.js";
import { AppMenu } from "./views/AppMenu.js";
import { CommandPalette } from "./views/CommandPalette.js";
import { QuickActions } from "./views/QuickActions.js";
import { FibersSheet } from "./views/FibersSheet.js";
import { ArchiveSheet } from "./views/ArchiveSheet.js";

export function App(): ReactNode {
  const [opened, setOpened] = useState<{
    connection: ConnectionInfo;
    initialSelected: string | null;
  } | null>(null);
  const pendingSelection = useRef<{
    rootPath: string;
    sessionId: string;
  } | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasBridge = bridge() !== undefined;

  const theme = useAppearance();

  useEffect(() => {
    const remote = connectionFromQuery();
    if (remote !== null) {
      setOpened({ connection: remote, initialSelected: null });
      return;
    }
    const b = bridge();
    if (b === undefined) return;
    let receivedConnection = false;
    void b.getState().then((state) => {
      // A project may finish opening while this initial request is in flight.
      // Never let the older snapshot switch the workspace back underneath it.
      if (receivedConnection) return;
      setOpened(
        state.connection === null
          ? null
          : { connection: state.connection, initialSelected: null },
      );
    });
    return b.onConnection((info) => {
      receivedConnection = true;
      const pending = pendingSelection.current;
      const opensPendingSession = pending?.rootPath === info.rootPath;
      if (opensPendingSession) pendingSelection.current = null;
      setOpened({
        connection: info,
        initialSelected: opensPendingSession ? pending.sessionId : null,
      });
      setOpening(null);
      setError(null);
    });
  }, []);

  const openProject = useCallback((rootPath: string, sessionId?: string) => {
    const b = bridge();
    if (b === undefined) return;
    pendingSelection.current =
      sessionId === undefined ? null : { rootPath, sessionId };
    setOpening(rootPath);
    setError(null);
    void b.openProject(rootPath).then((result) => {
      setOpening(null);
      if (!result.ok) {
        pendingSelection.current = null;
        setError(result.error);
      }
    });
  }, []);

  const pickProject = useCallback(() => {
    const b = bridge();
    if (b === undefined) return;
    pendingSelection.current = null;
    setError(null);
    void b.pickProject().then((result) => {
      if (result !== null && !result.ok) setError(result.error);
    });
  }, []);

  if (opened === null) {
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
    // The fan-out sits outside the key on purpose: the toolbar reports on
    // every loaded project, so its streams and snapshots have to survive the
    // switch that replaces the workspace under it.
    <ProjectFanoutProvider connection={opened.connection}>
      <HarnessProvider
        key={`${opened.connection.url}|${opened.connection.token}`}
        connection={opened.connection}
        initialSelected={opened.initialSelected}
      >
        <WorkspaceProvider>
          <Workspace
            theme={theme}
            switcher={
              hasBridge
                ? {
                    opening,
                    error,
                    onOpen: openProject,
                    onOpenSession: openProject,
                    onPick: pickProject,
                  }
                : undefined
            }
          />
        </WorkspaceProvider>
      </HarnessProvider>
    </ProjectFanoutProvider>
  );
}

/** Everything the toolbar switcher needs, absent when there is no bridge. */
interface SwitcherProps {
  opening: string | null;
  error: string | null;
  onOpen(rootPath: string): void;
  onOpenSession(rootPath: string, sessionId: string): void;
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
      <header className="toolbar">
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
        <ActivityMenu
          onOpenProject={props.switcher?.onOpen}
          onOpenProjectSession={props.switcher?.onOpenSession}
        />
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
        <QuickActions />
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
      {overlay === "archive" && <ArchiveSheet />}
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
