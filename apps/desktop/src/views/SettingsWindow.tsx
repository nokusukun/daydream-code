/**
 * The settings window: a source list over an opaque content pane, in its own
 * BrowserWindow.
 *
 * Curated sections carry the settings people actually change, grouped by what
 * they affect rather than by which plugin happens to own them. The plugins
 * section is the honest full list: every composition row, its module, its
 * fiber state, and a generic editor for anything the curated sections do not
 * claim — so a plugin nobody anticipated is still configurable here.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { EntryView, SettingsView } from "../api.js";
import { useHarness } from "../harness.js";
import { useSettings, type SettingsStore } from "../settings-store.js";
import { SettingField, SettingRow, isUserSet, layerName } from "./SettingsField.js";
import type { Appearance } from "../bridge.js";
import { bridge } from "../bridge.js";

interface Section {
  id: string;
  label: string;
  blurb: string;
  /** Composition rows this section owns. */
  rows: string[];
}

/**
 * Rows are claimed by id. An id that does not exist is simply not rendered, so
 * this list degrades to "shows less" rather than to a crash when the base
 * bundle changes underneath it — and anything unclaimed still surfaces under
 * plugins.
 */
const SECTIONS: Section[] = [
  {
    id: "general",
    label: "general",
    blurb: "what a new session starts with.",
    rows: [],
  },
  {
    id: "appearance",
    label: "appearance",
    blurb: "the app follows macOS. These are the values it read.",
    rows: [],
  },
  {
    id: "drivers",
    label: "drivers",
    blurb: "the agents that run sessions, and the models they offer.",
    rows: ["drivers", "driver-claude", "driver-codex", "driver-mock"],
  },
  {
    id: "context",
    label: "context",
    blurb: "how the master thread is measured, summarized and compacted.",
    rows: ["compaction", "summarizer", "tokens", "normalizer", "normalize-durable"],
  },
  {
    id: "coordination",
    label: "coordination",
    blurb: "how sessions reach each other and ask you questions.",
    rows: [
      "sessions",
      "asks",
      "questions",
      "tools",
      "recall-tools",
      "ask-tools",
      "ask-session-tools",
      "send-tools",
    ],
  },
  {
    id: "storage",
    label: "storage",
    blurb: "where the journal, the threads and attachments live.",
    rows: ["store", "blobs", "journal", "threads", "master-writeback", "master-inject"],
  },
  {
    id: "network",
    label: "network",
    blurb: "the HTTP surface this window talks to.",
    rows: ["server", "routes", "meta-routes"],
  },
  {
    id: "plugins",
    label: "plugins",
    blurb: "every row of the composition, in load order.",
    rows: [],
  },
];

export function SettingsWindow(): ReactNode {
  const { api, connection } = useHarness();
  const store = useSettings(api);
  const [section, setSection] = useState("general");
  const [advanced, setAdvanced] = useState(false);

  // ⌘W and Escape close the window, which is what every Mac settings pane does.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape" || ((event.metaKey || event.ctrlKey) && event.key === "w")) {
        event.preventDefault();
        window.close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const active = SECTIONS.find((candidate) => candidate.id === section) ?? SECTIONS[0]!;

  return (
    <div className="settings">
      <header className="settings-bar glass">
        <h1>{active.label}</h1>
        <div className="settings-bar-right">
          <label className="settings-scope" title="which config layer edits are written to">
            <span>writing to</span>
            <select
              className="set-input set-select"
              value={store.layer}
              onChange={(event) =>
                store.setLayer(event.target.value === "user" ? "user" : "project")
              }
            >
              <option value="project">this project</option>
              <option value="user">all projects</option>
            </select>
          </label>
        </div>
      </header>

      <nav className="settings-rail glass" aria-label="settings sections">
        <ul>
          {SECTIONS.map((candidate) => (
            <li key={candidate.id}>
              <button
                type="button"
                className={`settings-tab${candidate.id === section ? " is-on" : ""}`}
                aria-current={candidate.id === section ? "page" : undefined}
                onClick={() => setSection(candidate.id)}
              >
                {candidate.label}
              </button>
            </li>
          ))}
        </ul>
        <p className="settings-root" title={connection.rootPath}>
          {connection.name}
        </p>
      </nav>

      <main className="settings-pane">
        <RestartBar store={store} />
        {store.error !== null && (
          <div className="error-bar" role="alert">
            {store.error}
          </div>
        )}
        {store.loading && store.view === null ? (
          <SettingsSkeleton />
        ) : store.view === null ? null : (
          <>
            <p className="settings-blurb">{active.blurb}</p>
            <SectionBody
              section={active}
              view={store.view}
              store={store}
              advanced={advanced}
            />
            {active.id !== "appearance" && (
              <label className="settings-advanced">
                <input
                  type="checkbox"
                  checked={advanced}
                  onChange={(event) => setAdvanced(event.target.checked)}
                />
                show advanced settings
              </label>
            )}
          </>
        )}
      </main>
    </div>
  );
}

/**
 * A persistent bar, not a toast: a value that is saved but not running is a
 * standing discrepancy, and it should stay on screen until the relaunch that
 * resolves it.
 */
function RestartBar(props: { store: SettingsStore }): ReactNode {
  const { pendingRestart } = props.store;
  if (pendingRestart.length === 0) return null;
  return (
    <div className="settings-restart" role="status">
      <span>
        {pendingRestart.join(", ")} {pendingRestart.length === 1 ? "is" : "are"} saved but
        not running. quit and reopen to apply.
      </span>
      <button type="button" className="btn btn-quiet" onClick={props.store.refresh}>
        recheck
      </button>
    </div>
  );
}

function SettingsSkeleton(): ReactNode {
  return (
    <div aria-busy="true" className="settings-skel">
      {[0, 1, 2, 3, 4].map((index) => (
        <div key={index} className="set-row">
          <div className="set-label">
            <div className="skeleton" style={{ height: 13, width: 120 }} />
            <div className="skeleton" style={{ height: 11, width: 200, marginTop: 6 }} />
          </div>
          <div className="set-control">
            <div className="skeleton" style={{ height: 24, width: 160 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function SectionBody(props: {
  section: Section;
  view: SettingsView;
  store: SettingsStore;
  advanced: boolean;
}): ReactNode {
  const { section, view, store, advanced } = props;

  if (section.id === "general") return <GeneralSection view={view} store={store} />;
  if (section.id === "appearance") return <AppearanceSection />;
  if (section.id === "plugins") {
    return <PluginsSection view={view} store={store} advanced={advanced} />;
  }

  const claimed = section.rows
    .map((id) => view.entries.find((entry) => entry.id === id))
    .filter((entry): entry is EntryView => entry !== undefined);

  if (claimed.length === 0) {
    return <p className="settings-empty">no plugins in this group are part of the composition.</p>;
  }

  return (
    <>
      {claimed.map((entry) => (
        <PluginBlock key={entry.id} entry={entry} store={store} advanced={advanced} />
      ))}
    </>
  );
}

/** Project-row settings. Stored in the database, so they never need a relaunch. */
function GeneralSection(props: { view: SettingsView; store: SettingsStore }): ReactNode {
  const { view, store } = props;
  const { catalog } = useHarness();
  const { config } = view.project;
  const status = store.status.project;

  const drivers = catalog.map((entry) => entry.driver);
  const models = catalog.find((entry) => entry.driver === config.defaultDriver)?.models ?? [];

  return (
    <>
      <SettingRow
        label="default driver"
        help="used when a dispatch does not name one."
        status={status}
        showOrigin={false}
        control={
          <select
            className="set-input set-select"
            value={config.defaultDriver}
            onChange={(event) =>
              void store.setProject({ defaultDriver: event.target.value, defaultModel: null })
            }
          >
            {drivers.length === 0 && <option value={config.defaultDriver}>{config.defaultDriver}</option>}
            {drivers.map((driver) => (
              <option key={driver} value={driver}>
                {driver}
              </option>
            ))}
          </select>
        }
      />
      <SettingRow
        label="default model"
        help="left unset, the driver picks its own default."
        status={status}
        showOrigin={false}
        onReset={
          config.defaultModel !== null
            ? () => void store.setProject({ defaultModel: null })
            : undefined
        }
        control={
          <select
            className="set-input set-select"
            value={config.defaultModel ?? ""}
            onChange={(event) =>
              void store.setProject({
                defaultModel: event.target.value === "" ? null : event.target.value,
              })
            }
          >
            <option value="">driver default</option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
        }
      />

      <h2 className="settings-group">this project</h2>
      <Fact label="name" value={view.project.name} />
      <Fact label="root" value={view.project.rootPath} mono />
      <Fact label="project settings" value={view.layerFiles.project} mono />
      <Fact label="machine settings" value={view.layerFiles.user} mono />
      <Fact label="opened" value={new Date(view.project.createdAt).toLocaleString()} />
    </>
  );
}

function Fact(props: { label: string; value: string; mono?: boolean }): ReactNode {
  return (
    <div className="set-row set-row-fact">
      <div className="set-label">
        <span>{props.label}</span>
      </div>
      <div className="set-control">
        <span
          className={props.mono === true ? "set-fact set-mono" : "set-fact"}
          title={props.value}
        >
          {props.value}
        </span>
      </div>
    </div>
  );
}

/**
 * Appearance is read-only on purpose. The accent and the theme come from
 * System Settings, and an in-app override would be the app disagreeing with
 * the OS about something the OS owns.
 */
function AppearanceSection(): ReactNode {
  const [appearance, setAppearance] = useState<Appearance | null>(null);
  useEffect(() => {
    const api = bridge();
    if (api === undefined) return;
    void api.getAppearance().then(setAppearance).catch(() => undefined);
    return api.onAppearance(setAppearance);
  }, []);

  if (appearance === null) {
    return (
      <p className="settings-empty">
        appearance comes from the OS, and this renderer is not running inside the app.
      </p>
    );
  }

  return (
    <>
      <div className="set-row">
        <div className="set-label">
          <span>accent</span>
          <p className="set-help">from System Settings. Every selection and focus ring uses it.</p>
        </div>
        <div className="set-control">
          <span className="set-swatch-row">
            <span className="set-swatch" style={{ background: appearance.accent }} aria-hidden="true" />
            <span className="set-fact set-mono">{appearance.accent}</span>
          </span>
        </div>
      </div>
      <Fact label="theme" value={appearance.dark ? "dark" : "light"} />
      <Fact label="platform" value={appearance.platform} />
      <Fact
        label="translucency"
        value={appearance.vibrancy ? "on, window is vibrant" : "off, surfaces are opaque"}
      />
      <p className="settings-note">
        reduced transparency, increased contrast and reduced motion are honored from the OS
        too. There is nothing to switch here: changing any of them in System Settings
        changes the app immediately.
      </p>
    </>
  );
}

/** Every row, including the ones no curated section claims. */
function PluginsSection(props: {
  view: SettingsView;
  store: SettingsStore;
  advanced: boolean;
}): ReactNode {
  const { view, store, advanced } = props;
  const [open, setOpen] = useState<string | null>(null);
  const stuck = view.entries.filter(
    (entry) => !entry.disabled && entry.fiber?.state !== undefined && entry.fiber.state !== "active",
  ).length;

  return (
    <>
      {stuck > 0 && (
        <div className="settings-restart" role="alert">
          <span>
            {stuck} {stuck === 1 ? "plugin is" : "plugins are"} not active. open the row to
            see what it is missing.
          </span>
        </div>
      )}
      <ul className="plugin-list">
        {view.entries.map((entry) => (
          <li key={entry.id}>
            <PluginRow
              entry={entry}
              store={store}
              expanded={open === entry.id}
              onToggle={() => setOpen((current) => (current === entry.id ? null : entry.id))}
              advanced={advanced}
            />
          </li>
        ))}
      </ul>
    </>
  );
}

function PluginRow(props: {
  entry: EntryView;
  store: SettingsStore;
  expanded: boolean;
  advanced: boolean;
  onToggle(): void;
}): ReactNode {
  const { entry, store } = props;
  const state = entry.disabled ? "off" : (entry.fiber?.state ?? "not mounted");
  return (
    <div className={`plugin-row${entry.disabled ? " is-off" : ""}`}>
      <button
        type="button"
        className="plugin-head"
        aria-expanded={props.expanded}
        onClick={props.onToggle}
      >
        <span className={`plugin-state plugin-state-${state.replace(/\s+/g, "-")}`} aria-hidden="true" />
        <span className="plugin-id">{entry.id}</span>
        <span className="plugin-module set-mono">{entry.name ?? "patch only"}</span>
        <span className="plugin-flag">{state}</span>
      </button>
      {props.expanded && (
        <div className="plugin-body">
          {entry.fiber?.missing.length ? (
            <p className="set-note set-note-warn">
              waiting for {entry.fiber.missing.join(", ")}
            </p>
          ) : null}
          {entry.fiber?.error !== undefined && (
            <p className="set-note set-note-bad">{entry.fiber.error}</p>
          )}
          <SettingRow
            label="enabled"
            help={
              entry.restartRequired !== undefined
                ? `hot reload is off for this one: ${entry.restartRequired}.`
                : "unloading a plugin runs its disposers and unwinds anything that depends on it."
            }
            status={store.status[entry.id]}
            overridden={entry.origin.disabled !== undefined}
            origin={entry.origin.disabled}
            onReset={
              isUserSet(entry.origin.disabled)
                ? () => void store.resetRow(entry.id)
                : undefined
            }
            control={
              <label className="set-switch">
                <input
                  type="checkbox"
                  checked={!entry.disabled}
                  onChange={(event) => void store.setDisabled(entry.id, !event.target.checked)}
                />
                <span className="set-switch-track" aria-hidden="true">
                  <span className="set-switch-knob" />
                </span>
                <span className="set-switch-text">{entry.disabled ? "off" : "on"}</span>
              </label>
            }
          />
          <PluginFields entry={entry} store={store} advanced={props.advanced} />
        </div>
      )}
    </div>
  );
}

/** A named block of one plugin's settings, for the curated sections. */
function PluginBlock(props: {
  entry: EntryView;
  store: SettingsStore;
  advanced: boolean;
}): ReactNode {
  const { entry, store } = props;
  const visible = entry.fields.filter((field) => props.advanced || field.advanced !== true);
  const state = entry.disabled ? "off" : (entry.fiber?.state ?? "not mounted");

  return (
    <section className="settings-block">
      <h2 className="settings-group">
        {entry.id}
        <span className="settings-group-module set-mono">{entry.name}</span>
        <span className={`plugin-flag plugin-flag-${state.replace(/\s+/g, "-")}`}>{state}</span>
      </h2>
      {entry.live !== undefined && (
        <p className="set-note set-note-warn">
          saved, but still running the previous value. relaunch to apply.
        </p>
      )}
      <SettingRow
        label="enabled"
        help={
          entry.restartRequired !== undefined
            ? `changes here need a relaunch: ${entry.restartRequired}.`
            : undefined
        }
        status={store.status[entry.id]}
        overridden={entry.origin.disabled !== undefined}
        origin={entry.origin.disabled}
        onReset={
          isUserSet(entry.origin.disabled)
            ? () => void store.resetRow(entry.id)
            : undefined
        }
        control={
          <label className="set-switch">
            <input
              type="checkbox"
              checked={!entry.disabled}
              onChange={(event) => void store.setDisabled(entry.id, !event.target.checked)}
            />
            <span className="set-switch-track" aria-hidden="true">
              <span className="set-switch-knob" />
            </span>
            <span className="set-switch-text">{entry.disabled ? "off" : "on"}</span>
          </label>
        }
      />
      {visible.length === 0 && entry.fields.length > 0 && (
        <p className="settings-empty">its remaining settings are advanced.</p>
      )}
      <PluginFields entry={entry} store={store} advanced={props.advanced} />
    </section>
  );
}

function PluginFields(props: {
  entry: EntryView;
  store: SettingsStore;
  advanced: boolean;
}): ReactNode {
  const { entry, store } = props;
  const config = useMemo(
    () =>
      typeof entry.config === "object" && entry.config !== null && !Array.isArray(entry.config)
        ? (entry.config as Record<string, unknown>)
        : {},
    [entry.config],
  );

  const onChange = useCallback(
    (name: string, value: unknown) => void store.setField(entry.id, name, value),
    [entry.id, store],
  );
  const onReset = useCallback(
    (name: string) => void store.clearField(entry.id, name),
    [entry.id, store],
  );

  if (entry.fields.length === 0) {
    return (
      <p className="settings-empty">
        {entry.configurable
          ? "nothing to configure."
          : "this plugin declares no settings."}
      </p>
    );
  }

  const visible = entry.fields.filter((field) => props.advanced || field.advanced !== true);

  return (
    <>
      {visible.map((field) => {
        const set = Object.prototype.hasOwnProperty.call(config, field.name);
        return (
          <SettingField
            key={field.name}
            descriptor={field}
            value={set ? config[field.name] : field.default}
            overridden={set}
            origin={entry.origin.config}
            status={store.status[entry.id]}
            disabled={false}
            onChange={(value) => onChange(field.name, value)}
            onReset={() => onReset(field.name)}
          />
        );
      })}
    </>
  );
}

export { layerName };
