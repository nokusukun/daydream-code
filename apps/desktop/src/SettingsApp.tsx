/**
 * Root of the settings window.
 *
 * It bootstraps its own connection rather than sharing the workspace's: the
 * two windows are separate renderer processes, and a settings window that
 * could only exist alongside a live workspace would be the wrong dependency
 * for a surface whose whole job is fixing a misconfigured harness.
 */
import { useEffect, useState, type ReactNode } from "react";
import { bridge, connectionFromQuery, type ConnectionInfo } from "./bridge.js";
import { useAppearance } from "./appearance.js";
import { HarnessProvider } from "./harness.js";
import { SettingsWindow } from "./views/SettingsWindow.js";

export function SettingsApp(): ReactNode {
  const [connection, setConnection] = useState<ConnectionInfo | null>(null);
  const [ready, setReady] = useState(false);
  useAppearance();

  useEffect(() => {
    const remote = connectionFromQuery();
    if (remote !== null) {
      setConnection(remote);
      setReady(true);
      return;
    }
    const api = bridge();
    if (api === undefined) {
      setReady(true);
      return;
    }
    void api
      .getState()
      .then((state) => setConnection(state.connection))
      .catch(() => undefined)
      .finally(() => setReady(true));
    return api.onConnection(setConnection);
  }, []);

  if (!ready) return <div className="settings settings-booting" aria-busy="true" />;

  if (connection === null) {
    return (
      <div className="settings settings-booting">
        <p className="settings-empty">
          no project is open. open one in the main window, then come back.
        </p>
      </div>
    );
  }

  return (
    <HarnessProvider
      key={`${connection.url}|${connection.token}`}
      connection={connection}
    >
      <SettingsWindow />
    </HarnessProvider>
  );
}
