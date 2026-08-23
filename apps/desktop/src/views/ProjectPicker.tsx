/** Shown when no project is open: recent projects + open-folder dialog. */
import { useState, type ReactNode } from "react";
import type { RegistryEntry } from "../bridge.js";
import { fmtDateTime } from "../ui.js";

export function ProjectPicker(props: {
  recent: RegistryEntry[];
  opening: string | null;
  error: string | null;
  onOpen(rootPath: string): void;
  onPick(): void;
  hasBridge: boolean;
}): ReactNode {
  const [busyPick, setBusyPick] = useState(false);
  return (
    <div className="picker">
      <div className="picker-card">
        <h1>daydream-code</h1>
        <p className="picker-sub">
          Pick a project — the harness boots per project, and every project
          carries one continuous, journaled master thread.
        </p>
        {props.error !== null && <div className="error-bar">{props.error}</div>}
        {!props.hasBridge && (
          <div className="error-bar">
            No Electron bridge found. Run inside the desktop shell, or pass
            ?url=&amp;token= to point this page at a running core.
          </div>
        )}
        <button
          type="button"
          className="primary picker-open"
          disabled={!props.hasBridge || busyPick || props.opening !== null}
          onClick={() => {
            setBusyPick(true);
            props.onPick();
            // Re-enabled when state updates propagate; cheap safety timer:
            setTimeout(() => setBusyPick(false), 500);
          }}
        >
          Open project folder…
        </button>
        {props.recent.length > 0 && (
          <>
            <h3>recent</h3>
            <ul className="picker-recent">
              {props.recent.map((entry) => (
                <li key={entry.rootPath}>
                  <button
                    type="button"
                    disabled={!props.hasBridge || props.opening !== null}
                    onClick={() => props.onOpen(entry.rootPath)}
                  >
                    <span className="picker-name">
                      {props.opening === entry.rootPath ? "booting… " : ""}
                      {entry.name}
                    </span>
                    <span className="picker-path">{entry.rootPath}</span>
                    <span className="picker-when">{fmtDateTime(entry.lastOpenedAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
