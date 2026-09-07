import { useEffect, useState, type ReactNode } from "react";
import { bridge } from "./bridge.js";

/** Native-density controls for the frameless Windows title bar. */
export function WindowControls(): ReactNode {
  const api = bridge();
  const [maximized, setMaximized] = useState(false);
  const isWindows = navigator.userAgent.includes("Windows");

  useEffect(() => {
    if (!isWindows || api === undefined) return;
    void api.getWindowState().then((state) => setMaximized(state.maximized));
    return api.onWindowState((state) => setMaximized(state.maximized));
  }, [api, isWindows]);

  if (!isWindows || api === undefined) return null;

  return (
    <div className="window-controls" aria-label="Window controls">
      <button
        type="button"
        className="window-control"
        aria-label="Minimize window"
        title="Minimize"
        onClick={() => void api.minimizeWindow()}
      >
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1 5.5h8" />
        </svg>
      </button>
      <button
        type="button"
        className="window-control"
        aria-label={maximized ? "Restore window" : "Maximize window"}
        title={maximized ? "Restore" : "Maximize"}
        onClick={() => void api.toggleMaximizeWindow()}
      >
        {maximized ? (
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <path d="M3 1.5h5.5V7H7M1.5 3H7v5.5H1.5z" />
          </svg>
        ) : (
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <path d="M1.5 1.5h7v7h-7z" />
          </svg>
        )}
      </button>
      <button
        type="button"
        className="window-control window-control-close"
        aria-label="Close window"
        title="Close"
        onClick={() => void api.closeWindow()}
      >
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="m1.5 1.5 7 7m0-7-7 7" />
        </svg>
      </button>
    </div>
  );
}
