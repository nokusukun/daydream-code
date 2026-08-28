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
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { bridge, connectionFromQuery, type ConnectionInfo } from "./bridge.js";
import { useAppearance, type ThemeState } from "./appearance.js";
import { HarnessProvider, useHarness } from "./harness.js";
import { WorkspaceProvider, useWorkspace } from "./workspace.js";
import { useDismiss } from "./overlay.js";
import { SplitPane } from "./split.js";
import { ProjectPicker } from "./views/ProjectPicker.js";
import { ProjectSwitcher, useSwitcherHotkey } from "./views/ProjectSwitcher.js";
import { ProjectFanoutProvider } from "./project-fanout.js";
import {
  DesktopHostProvider,
  type DesktopHost,
  type ProjectSwitcherHost,
} from "./modules/host.js";
import {
  ModuleBoundary,
  useDesktopModuleRuntime,
  useDesktopModules,
} from "./modules/react.js";

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

function Workspace(props: {
  theme: ThemeState;
  switcher?: ProjectSwitcherHost | undefined;
}): ReactNode {
  const {
    connection,
    newSession,
    overlay,
    setOverlay,
    mode,
    setMode,
    sidebar,
    toggleSidebar,
  } = useHarness();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const modeMenuRef = useRef<HTMLDivElement>(null);
  const modules = useDesktopModules<DesktopHost>();
  const moduleRuntime = useDesktopModuleRuntime<DesktopHost>();
  const hasSwitcher = props.switcher !== undefined;
  const toggleSwitcher = useCallback(() => {
    if (hasSwitcher) setSwitcherOpen((o) => !o);
  }, [hasSwitcher]);
  useSwitcherHotkey(toggleSwitcher);
  useDismiss(modeMenuRef, modeMenuOpen, () => setModeMenuOpen(false));

  const openSwitcher = useCallback(() => {
    if (hasSwitcher) setSwitcherOpen(true);
  }, [hasSwitcher]);
  const host = useMemo<DesktopHost>(
    () => ({
      theme: props.theme,
      ...(props.switcher === undefined ? {} : { switcher: props.switcher }),
      openSwitcher,
    }),
    [props.theme, props.switcher, openSwitcher],
  );

  const activeMode = modules.modes.find((entry) => entry.id === mode);
  const loadingModules = modules.statuses.some(
    (entry) => entry.state === "loading",
  );
  const failedModules = modules.statuses.filter(
    (entry) => entry.state === "failed",
  );
  const activeOverlay =
    overlay === null
      ? undefined
      : modules.overlays.find((entry) => entry.id === overlay);

  // Do not jump to whichever module wins an import race. Once discovery has
  // settled, fall back only if the selected mode genuinely is unavailable.
  useEffect(() => {
    if (
      !loadingModules &&
      activeMode === undefined &&
      modules.modes[0] !== undefined
    ) {
      setMode(modules.modes[0].id);
    }
  }, [activeMode, loadingModules, modules.modes, setMode]);

  // App-level shortcuts, bound here rather than per-view because none of them
  // belongs to a view: ⌘K and ⌘N reach the whole window, ⌘, is the platform's
  // settings key, and ⌘⇧E is what every editor uses to get to the file tree.
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
        const at = modules.modes.findIndex((entry) => entry.id === mode);
        const next = modules.modes[(at + 1) % modules.modes.length];
        if (next !== undefined) setMode(next.id);
      }
      if (event.key === ",") {
        event.preventDefault();
        void bridge()?.openSettings();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overlay, setOverlay, newSession, toggleSidebar, setMode, mode, modules.modes]);

  const Panel = activeMode?.panel;
  const panel =
    Panel === undefined ? (
      <main className="panel module-empty" aria-busy={loadingModules}>
        {loadingModules
          ? "loading desktop modules…"
          : "no workspace module is available"}
      </main>
    ) : (
      <ModuleBoundary moduleId={activeMode?.id ?? mode} surface="panel">
        <Panel />
      </ModuleBoundary>
    );
  const Sidebar = activeMode?.sidebar;

  return (
    <DesktopHostProvider value={host}>
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

        <div className="mode-control" ref={modeMenuRef}>
          <div
            className="segmented segmented-mode"
            role="tablist"
            aria-label="Mode"
          >
            {modules.modes.map((entry) => (
              <button
                type="button"
                key={entry.id}
                role="tab"
                aria-selected={mode === entry.id}
                title={`${entry.label} (⌘⇧E)`}
                onClick={() => setMode(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="mode-menu-trigger"
            aria-label={`Workspace view: ${activeMode?.label ?? "View"}`}
            aria-expanded={modeMenuOpen}
            aria-haspopup="menu"
            title="Switch workspace view (⌘⇧E)"
            onClick={() => setModeMenuOpen((open) => !open)}
          >
            <span>{activeMode?.label ?? "View"}</span>
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <path d="m3.25 4.75 2.75 2.5 2.75-2.5" />
            </svg>
          </button>
          {modeMenuOpen && (
            <div className="mode-pop pop" role="menu" aria-label="Workspace view">
              <div className="pop-head">view</div>
              {modules.modes.map((entry) => (
                <button
                  type="button"
                  key={entry.id}
                  className="pop-row mode-pop-row"
                  role="menuitemradio"
                  aria-checked={mode === entry.id}
                  onClick={() => {
                    setMode(entry.id);
                    setModeMenuOpen(false);
                  }}
                >
                  <span className="mode-pop-check" aria-hidden="true">
                    {mode === entry.id && (
                      <svg viewBox="0 0 12 12">
                        <path d="m2.25 6.25 2.35 2.2 5.15-5.1" />
                      </svg>
                    )}
                  </span>
                  <span className="pop-row-title">{entry.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <span className="toolbar-spacer" />
        {modules.toolbar
          .filter((entry) => entry.position === "center")
          .map(({ id, Component }) => (
            <ModuleBoundary key={id} moduleId={id} surface="toolbar">
              <Component host={host} />
            </ModuleBoundary>
          ))}
        <span className="toolbar-spacer" />

        <div className="toolbar-actions" role="group" aria-label="Toolbar actions">
          <button
            type="button"
            className="titlebar-search"
            aria-label="Search or jump to"
            title="Search or jump to (Command-K)"
            onClick={() => setOverlay("palette")}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="7" cy="7" r="4.25" />
              <path d="m10.25 10.25 3 3" />
            </svg>
            <span className="titlebar-search-label">Search or jump to…</span>
            <kbd>⌘K</kbd>
          </button>
          <button
            type="button"
            className="toolbar-icon"
            aria-label={
              props.theme.resolved === "dark"
                ? "Use light theme"
                : "Use dark theme"
            }
            title={`Appearance: ${props.theme.choice}`}
            onClick={props.theme.toggle}
          >
            {props.theme.resolved === "dark" ? (
              <svg
                viewBox="0 0 16 16"
                width="15"
                height="15"
                aria-hidden="true"
                focusable="false"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              >
                <circle cx="8" cy="8" r="2.6" />
                <path d="M8 1.5v1.3M8 13.2v1.3M1.5 8h1.3M13.2 8h1.3M3.4 3.4l.9.9M11.7 11.7l.9.9M12.6 3.4l-.9.9M4.3 11.7l-.9.9" />
              </svg>
            ) : (
              <svg
                viewBox="0 0 16 16"
                width="15"
                height="15"
                aria-hidden="true"
                focusable="false"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12.9 10.5A5.65 5.65 0 0 1 5.5 3.1 5.65 5.65 0 1 0 12.9 10.5Z" />
              </svg>
            )}
          </button>
          {failedModules.length > 0 && (
            <button
              type="button"
              className="toolbar-icon module-health"
              aria-label={`Retry ${failedModules.length} failed desktop modules`}
              title={failedModules
                .map((entry) => `${entry.name}: ${entry.error}`)
                .join("\n")}
              onClick={() => {
                for (const entry of failedModules) void moduleRuntime.retry(entry.id);
              }}
            >
              !
            </button>
          )}
          {modules.toolbar
            .filter((entry) => entry.position === "actions")
            .map(({ id, Component }) => (
              <ModuleBoundary key={id} moduleId={id} surface="toolbar">
                <Component host={host} />
              </ModuleBoundary>
            ))}
        </div>
      </header>

      {/* Two ids, not one: a file tree and a run list want different widths,
          and sharing a key would make switching modes resize the other one. */}
      {sidebar && Sidebar !== undefined ? (
        <SplitPane
          id={activeMode?.splitId ?? `shell-${mode}`}
          className="body"
          direction="row"
          fixed="first"
          label="Resize sidebar"
          initial={268}
          min={180}
          max={520}
          first={
            <aside className="sidebar glass">
              <ModuleBoundary
                moduleId={activeMode?.id ?? mode}
                surface="sidebar"
              >
                <Sidebar />
              </ModuleBoundary>
            </aside>
          }
          second={panel}
        />
      ) : (
        <div className="body">{panel}</div>
      )}

      {activeOverlay !== undefined && (
        <ModuleBoundary
          key={activeOverlay.id}
          moduleId={activeOverlay.id}
          surface="overlay"
          onDismiss={() => setOverlay(null)}
        >
          <activeOverlay.Component />
        </ModuleBoundary>
      )}
      </div>
    </DesktopHostProvider>
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
