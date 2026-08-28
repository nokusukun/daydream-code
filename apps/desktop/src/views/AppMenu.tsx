/**
 * The gear popover: the handful of settings worth reaching without leaving the
 * window, and the way into the ones that are not.
 *
 * Deliberately short. The full settings surface is generated from what every
 * mounted plugin declares and lives in its own window; duplicating a slice of
 * it here would mean two places that disagree the moment a plugin is swapped.
 * What earns a spot is what you change while looking at a run: appearance, the
 * model the next run gets, and where everything else is.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ProjectRecord } from "@daydream-code/shared";
import { bridge } from "../bridge.js";
import { useHarness } from "../harness.js";
import { GearIcon } from "../ui.js";
import { useDismiss } from "../overlay.js";
import type { ThemeState, ThemeChoice } from "../appearance.js";

const THEMES: Array<[ThemeChoice, string]> = [
  ["system", "System"],
  ["light", "Light"],
  ["dark", "Dark"],
];

export function AppMenu(props: { theme: ThemeState }): ReactNode {
  const { api, connection, setOverlay, wsStatus, modelLabel, resyncTick } =
    useHarness();
  const [open, setOpen] = useState(false);
  const [project, setProject] = useState<ProjectRecord | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const hasBridge = bridge() !== undefined;

  useDismiss(rootRef, open, () => setOpen(false));

  // Only while the menu is open: the default model is a value nobody watches
  // change, so polling it behind a closed popover is pure noise on the wire.
  useEffect(() => {
    if (!open) return;
    let stale = false;
    api
      .project()
      .then((record) => {
        if (!stale) setProject(record);
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [api, open, resyncTick]);

  const model =
    project === null
      ? null
      : modelLabel(project.config.defaultDriver, project.config.defaultModel);

  return (
    <div className="app-menu" ref={rootRef}>
      <button
        type="button"
        className="toolbar-icon"
        aria-label="Settings"
        aria-expanded={open}
        aria-haspopup="menu"
        title="Settings"
        onClick={() => setOpen((v) => !v)}
      >
        <GearIcon />
      </button>

      {open && (
        <div className="app-pop pop" role="menu">
          <div className="pop-head">settings</div>

          <div className="pop-field">
            <span className="pop-field-label">Appearance</span>
            <div className="segmented segmented-sm">
              {THEMES.map(([value, label]) => (
                <button
                  type="button"
                  key={value}
                  aria-pressed={props.theme.choice === value}
                  onClick={() => props.theme.set(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="pop-field">
            <span className="pop-field-label">Default model</span>
            <span className="pop-value" title="Used by every new thread in this project">
              {model === null ? "…" : model.label}
              {model?.variant !== undefined && <i>{model.variant}</i>}
            </span>
          </div>

          <div className="pop-field">
            <span className="pop-field-label">Core</span>
            <span className={`pop-value ws-${wsStatus}`} title={connection.url}>
              {wsStatus === "open" ? "connected" : wsStatus}
            </span>
          </div>

          <div className="pop-sep" role="presentation" />

          <button
            type="button"
            className="pop-row"
            onClick={() => {
              setOverlay("fibers");
              setOpen(false);
            }}
          >
            <span className="pop-row-title">Plugins &amp; fibers…</span>
          </button>

          {hasBridge && (
            <button
              type="button"
              className="pop-row"
              onClick={() => {
                void bridge()?.openSettings();
                setOpen(false);
              }}
            >
              <span className="pop-row-title">All settings…</span>
              <span className="pop-row-meta">
                <kbd>⌘,</kbd>
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
