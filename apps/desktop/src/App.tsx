import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  bridge,
  connectionFromQuery,
  type ConnectionInfo,
  type RegistryEntry,
} from "./bridge.js";
import { HarnessProvider, useHarness } from "./harness.js";
import { SplitPane } from "./split.js";
import { ProjectPicker } from "./views/ProjectPicker.js";
import { ProjectHome } from "./views/ProjectHome.js";
import { SessionView } from "./views/SessionView.js";
import { JournalSearch } from "./views/JournalSearch.js";
import { FibersPanel } from "./views/FibersPanel.js";

export function App(): ReactNode {
  const [connection, setConnection] = useState<ConnectionInfo | null>(null);
  const [recent, setRecent] = useState<RegistryEntry[]>([]);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasBridge = bridge() !== undefined;

  useEffect(() => {
    const remote = connectionFromQuery();
    if (remote !== null) {
      setConnection(remote);
      return;
    }
    const b = bridge();
    if (b === undefined) return;
    void b.getState().then((state) => {
      setConnection(state.connection);
      setRecent(state.recent);
    });
    return b.onConnection((info) => {
      setConnection(info);
      setOpening(null);
      setError(null);
      void b.getState().then((state) => setRecent(state.recent));
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
        recent={recent}
        opening={opening}
        error={error}
        onOpen={openProject}
        onPick={pickProject}
        hasBridge={hasBridge}
      />
    );
  }

  return (
    <HarnessProvider key={`${connection.url}|${connection.token}`} connection={connection}>
      <Shell onSwitchProject={hasBridge ? pickProject : undefined} />
    </HarnessProvider>
  );
}

function Shell(props: { onSwitchProject?: (() => void) | undefined }): ReactNode {
  const { connection, view, navigate, wsStatus } = useHarness();
  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">daydream-code</span>
        <span className="project" title={connection.rootPath}>
          {connection.name}
        </span>
        <nav className="tabs">
          <button
            type="button"
            className={
              view.name === "home" || view.name === "session"
                ? "tab active"
                : "tab"
            }
            onClick={() => navigate({ name: "home" })}
          >
            home
          </button>
          <button
            type="button"
            className={view.name === "search" ? "tab active" : "tab"}
            onClick={() => navigate({ name: "search" })}
          >
            search
          </button>
          <button
            type="button"
            className={view.name === "fibers" ? "tab active" : "tab"}
            onClick={() => navigate({ name: "fibers" })}
          >
            fibers
          </button>
        </nav>
        <span className={`ws-dot ws-${wsStatus}`} title={`stream: ${wsStatus}`} />
        {props.onSwitchProject !== undefined && (
          <button type="button" className="tab" onClick={props.onSwitchProject}>
            switch project
          </button>
        )}
      </header>
      <main className="content">
        {view.name === "home" && <ProjectHome />}
        {view.name === "session" && (
          // Master thread stays visible beside the session; the handle
          // adjusts the session pane's width (persisted).
          <SplitPane
            id="shell-session"
            direction="row"
            initial={620}
            min={380}
            max={1400}
            first={<ProjectHome />}
            second={<SessionView key={view.id} id={view.id} />}
          />
        )}
        {view.name === "search" && <JournalSearch />}
        {view.name === "fibers" && <FibersPanel />}
      </main>
    </div>
  );
}
