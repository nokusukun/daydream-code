import { defineConfig, field, settingsOf, type ConfigOf } from "@daydream-code/config";
import type { Context } from "@daydream-code/kernel";
import type { ComposedEntry, Layer } from "@daydream-code/boot";
import { layerPath } from "@daydream-code/boot";
import type {} from "@daydream-code/store";
import type { Sessions } from "@daydream-code/session";
import {
  HarnessConfig,
  type ApplyOutcome,
  type EntryView,
  type RowOrigin,
  type SettingsView,
  type WritableLayer,
  type WriteRequest,
  type WriteResult,
} from "./index.js";
import { patchLayerFile } from "./layer-file.js";

export const { Config, settings } = defineConfig({
  projectRoot: field.string({
    label: "project root",
    help: "which project's config layers are read and written. Defaults to the open project.",
    optional: true,
    advanced: true,
    restart: true,
  }),
});

/**
 * Rows that can only change across a relaunch, and why.
 *
 * Matched on the module specifier rather than the row id, because the id is
 * just a label a config layer can rename, while the module is what actually
 * determines whether unloading is survivable.
 */
const RESTART_ONLY: ReadonlyArray<readonly [prefix: string, reason: string]> = [
  [
    "@daydream-code/store/",
    "it owns the open database, and every other plugin depends on it",
  ],
  ["@daydream-code/server/", "this window is connected through it"],
  ["@daydream-code/settings/", "it is the plugin applying the change"],
];

/**
 * Rows a turn in flight writes through. Unloading one mid-run does not corrupt
 * anything — the journal is append-only and the kernel unwinds dependents
 * cleanly — but the run's next append would throw, which surfaces to the user
 * as a driver error they did not cause. Cheaper to wait.
 */
const BUSY_SENSITIVE: readonly string[] = [
  "@daydream-code/session/",
  "@daydream-code/journal/",
  "@daydream-code/thread/",
];

function matchPrefix(name: string | undefined, prefixes: readonly string[]): boolean {
  return name !== undefined && prefixes.some((prefix) => name.startsWith(prefix));
}

function restartReason(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  for (const [prefix, reason] of RESTART_ONLY) {
    if (name.startsWith(prefix)) return reason;
  }
  return undefined;
}

/** Whether two rows differ in any way that would change what is mounted. */
function differs(a: ComposedEntry | undefined, b: ComposedEntry): boolean {
  if (a === undefined) return true;
  return (
    a.name !== b.name ||
    (a.disabled ?? false) !== (b.disabled ?? false) ||
    JSON.stringify(a.isolate ?? []) !== JSON.stringify(b.isolate ?? []) ||
    JSON.stringify(a.config ?? null) !== JSON.stringify(b.config ?? null)
  );
}

/**
 * Which layer last set each part of each row.
 *
 * Recovered by replaying the layers rather than read off the composed result,
 * which keeps only the list of layers that touched a row. The distinction is
 * the whole point of the settings UI: "50000" means something different when
 * the base bundle chose it than when this project did.
 */
function provenance(layers: readonly Layer[]): Map<string, RowOrigin> {
  const origins = new Map<string, RowOrigin>();
  const note = (id: string, key: keyof RowOrigin, source: string): void => {
    const current = origins.get(id) ?? {};
    current[key] = source;
    origins.set(id, current);
  };
  for (const layer of layers) {
    for (const row of layer.rows) {
      for (const inserted of row.insert ?? []) {
        if (inserted.id === undefined) continue;
        note(inserted.id, "name", layer.source);
        if (inserted.config !== undefined) note(inserted.id, "config", layer.source);
        if (inserted.disabled !== undefined) note(inserted.id, "disabled", layer.source);
        if (inserted.isolate !== undefined) note(inserted.id, "isolate", layer.source);
      }
      if (row.insert !== undefined || row.id === undefined) continue;
      if (row.name !== undefined) note(row.id, "name", layer.source);
      if (row.config !== undefined) note(row.id, "config", layer.source);
      if (row.disabled !== undefined) note(row.id, "disabled", layer.source);
      if (row.isolate !== undefined) note(row.id, "isolate", layer.source);
    }
  }
  return origins;
}

/**
 * Default provider: reads the composition through `ctx.composition`, recovers
 * each plugin's schema from the module it already loaded, and writes changes
 * back to whichever layer file the caller names.
 */
export default class LiveConfig extends HarnessConfig {
  static inject = ["composition", "store"];
  static Config = Config;
  static settings = settings;

  readonly #projectRoot: string;
  constructor(ctx: Context, config: ConfigOf<typeof Config>) {
    super(ctx);
    this.#projectRoot = config.projectRoot ?? ctx.store.rootPath;
  }

  async view(): Promise<SettingsView> {
    const composition = this.ctx.composition;
    const layers = composition.collect();
    const origins = provenance(layers);
    const dump = new Map(
      this.ctx.registry.dumpState().map((fiber) => [fiber.uid, fiber]),
    );

    // Saved state comes from a fresh compose, live state from what is mounted.
    // They are the same until a restart-required row is changed, and keeping
    // them apart is what lets the UI show a control holding the new value
    // while still saying which value is actually running.
    const { entries: saved, warnings } = composition.recompose();
    const live = new Map(composition.entries.map((entry) => [entry.id, entry]));

    const entries = await Promise.all(
      saved.map(async (entry): Promise<EntryView> => {
        const mounted = composition.mountedEntry(entry.id);
        const plugin = await composition.describe(entry);
        const fields = settingsOf(plugin) ?? [];
        const fiber = mounted?.fiber != null ? dump.get(mounted.fiber.uid) : undefined;
        const restart = restartReason(entry.name);
        const running = live.get(entry.id);
        const drifted = running !== undefined && differs(running, entry);
        return {
          id: entry.id,
          ...(entry.name !== undefined ? { name: entry.name } : {}),
          disabled: entry.disabled ?? false,
          isolate: [...(entry.isolate ?? [])],
          config: entry.config ?? null,
          layers: [...entry.layers],
          origin: origins.get(entry.id) ?? {},
          fields,
          configurable: fields.length > 0,
          ...(drifted
            ? {
                live: {
                  config: running.config ?? null,
                  disabled: running.disabled ?? false,
                },
              }
            : {}),
          ...(fiber !== undefined
            ? {
                fiber: {
                  state: fiber.state,
                  missing: [...fiber.missing],
                  ...(fiber.error !== undefined ? { error: fiber.error } : {}),
                },
              }
            : {}),
          ...(mounted?.error !== undefined && fiber === undefined
            ? { fiber: { state: "failed", missing: [], error: String(mounted.error) } }
            : {}),
          ...(restart !== undefined ? { restartRequired: restart } : {}),
        };
      }),
    );

    return {
      project: this.ctx.store.project,
      layerFiles: {
        user: layerPath("user", this.#projectRoot),
        project: layerPath("project", this.#projectRoot),
      },
      entries,
      warnings: warnings.map((warning) => ({ ...warning })),
      running: this.#running(),
    };
  }

  async write(request: WriteRequest): Promise<WriteResult> {
    const file = layerPath(request.layer, this.#projectRoot);
    patchLayerFile(file, request);
    const result =
      request.apply === false
        ? { view: await this.view(), outcomes: [] }
        : await this.apply();
    this.ctx.emit("settings/written", result);
    return result;
  }

  async apply(): Promise<WriteResult> {
    const composition = this.ctx.composition;
    const { entries, warnings } = composition.recompose();
    const previous = new Map(composition.entries.map((entry) => [entry.id, entry]));
    const running = this.#running().length > 0;
    const outcomes: ApplyOutcome[] = [];

    for (const entry of entries) {
      const before = previous.get(entry.id);
      previous.delete(entry.id);
      if (!differs(before, entry)) continue;

      const restart = restartReason(entry.name) ?? restartReason(before?.name);
      if (restart !== undefined) {
        outcomes.push({ id: entry.id, status: "restart-required", reason: restart });
        continue;
      }
      if (running && matchPrefix(entry.name ?? before?.name, BUSY_SENSITIVE)) {
        outcomes.push({
          id: entry.id,
          status: "restart-required",
          reason: "a session is running; it would break the turn in flight",
        });
        continue;
      }
      outcomes.push(await this.#swap(entry, before));
    }

    // Ids present before and gone now: the row was deleted outright.
    for (const [id, before] of previous) {
      const restart = restartReason(before.name);
      if (restart !== undefined) {
        outcomes.push({ id, status: "restart-required", reason: restart });
        continue;
      }
      try {
        await composition.remove(id);
        outcomes.push({ id, status: "unmounted" });
      } catch (error) {
        outcomes.push({ id, status: "failed", reason: String(error) });
      }
    }

    // `composition.entries` already tracks exactly what took: `replace` and
    // `remove` update it, and a row that was skipped keeps its old entry. So
    // the view keeps showing what is *running*, not what is merely saved,
    // which is the whole reason a restart-required row is worth flagging.
    composition.setWarnings(warnings);

    return { view: await this.view(), outcomes };
  }

  async #swap(
    entry: ComposedEntry,
    before: ComposedEntry | undefined,
  ): Promise<ApplyOutcome> {
    const composition = this.ctx.composition;
    try {
      if (entry.disabled === true) {
        await composition.unmount(entry.id);
        return { id: entry.id, status: "unmounted" };
      }
      const mounted = await composition.replace(entry);
      if (mounted.error !== undefined) {
        return { id: entry.id, status: "failed", reason: String(mounted.error) };
      }
      const state = mounted.fiber?.state;
      if (state === "failed") {
        return {
          id: entry.id,
          status: "failed",
          reason: String(mounted.fiber?.error ?? "plugin failed to load"),
        };
      }
      return {
        id: entry.id,
        status: before?.disabled === true || before === undefined ? "mounted" : "reloaded",
      };
    } catch (error) {
      return { id: entry.id, status: "failed", reason: String(error) };
    }
  }

  #running(): string[] {
    const sessions = this.ctx.get("sessions") as Sessions | undefined;
    if (sessions === undefined) return [];
    try {
      return sessions.running().map((id) => String(id));
    } catch {
      return [];
    }
  }

}
