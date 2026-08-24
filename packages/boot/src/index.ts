import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { App, type Context } from "@daydream-code/kernel";
import { Composition } from "./composition.js";
import {
  composeEntries,
  renderConfigDump,
  type ComposedEntry,
  type ComposeWarning,
  type Layer,
  type PatchRow,
} from "./entries.js";
import { baseBundle } from "./base.js";
import { mountEntries, type MountedEntry } from "./loader.js";

export * from "./entries.js";
export * from "./loader.js";
export { baseBundle } from "./base.js";
export { Composition } from "./composition.js";

export interface BootOptions {
  projectRoot: string;
  /** Extra patch rows applied last (e.g. from CLI flags). */
  overrides?: PatchRow[];
  /** Skip mounting; compose only (for --dump-config). */
  composeOnly?: boolean;
  /** Replace the built-in base bundle (tests). */
  base?: Layer;
  /**
   * Directories bare plugin specifiers resolve from (the host app's package
   * dir, typically). The project root is always tried last, so projects can
   * install their own plugin packages.
   */
  resolutionPaths?: string[];
}

export interface BootResult {
  app: App;
  ctx: Context;
  entries: ComposedEntry[];
  warnings: ComposeWarning[];
  mounted: Map<string, MountedEntry>;
  dumpConfig(): string;
}

function fileLayer(path: string, source: string): Layer | null {
  if (!existsSync(path)) return null;
  const parsed = parseYaml(readFileSync(path, "utf8"));
  if (parsed == null) return null;
  if (!Array.isArray(parsed)) {
    throw new Error(`${source}: config must be a YAML list of entries`);
  }
  return { source, baseDir: dirname(path), rows: parsed as PatchRow[] };
}

/** Absolute path of a writable config layer. */
export function layerPath(which: "user" | "project", projectRoot: string): string {
  return which === "user"
    ? join(homedir(), ".daydream-code", "config.yml")
    : join(resolve(projectRoot), ".daydream-code", "config.yml");
}

/**
 * Read the layers in precedence order. Exported so a reload can re-read them
 * without going through `composeLayers` — the settings surface needs the
 * layers themselves to answer "which one set this value", which the composed
 * result no longer distinguishes.
 */
export function collectLayers(options: BootOptions): Layer[] {
  const projectRoot = resolve(options.projectRoot);
  const layers: Layer[] = [options.base ?? baseBundle(projectRoot)];
  const userConfig = fileLayer(layerPath("user", projectRoot), "user:config.yml");
  if (userConfig) layers.push(userConfig);
  const projectConfig = fileLayer(
    layerPath("project", projectRoot),
    "project:config.yml",
  );
  if (projectConfig) layers.push(projectConfig);
  if (options.overrides?.length) {
    layers.push({
      source: "overrides",
      baseDir: projectRoot,
      rows: options.overrides,
    });
  }
  return layers;
}

export function composeLayers(options: BootOptions): {
  entries: ComposedEntry[];
  warnings: ComposeWarning[];
} {
  return composeEntries(collectLayers(options));
}

/**
 * Compose config layers, create the app, and mount every enabled entry.
 * `--dump-config` uses the same compose path (composeOnly) so what you see is
 * what boots.
 */
export async function boot(options: BootOptions): Promise<BootResult> {
  const { entries, warnings } = composeLayers(options);
  const app = new App();
  let mounted = new Map<string, MountedEntry>();
  if (!options.composeOnly) {
    const resolutionPaths = [
      ...(options.resolutionPaths ?? []),
      resolve(options.projectRoot),
    ];
    // Before the rows, so a row may inject it. It closes over `options` so a
    // reload re-reads the same layers this boot did, CLI overrides included.
    let composition!: Composition;
    app.rootCtx.plugin(
      (ctx: Context) => {
        composition = new Composition(
          ctx,
          () => collectLayers(options),
          resolutionPaths,
        );
      },
      undefined,
    );
    await app.settle();
    mounted = await mountEntries(app.rootCtx, entries, resolutionPaths);
    await app.settle();
    composition.adopt(entries, warnings, mounted);
  }
  return {
    app,
    ctx: app.rootCtx,
    entries,
    warnings,
    mounted,
    dumpConfig: () => renderConfigDump(entries, warnings),
  };
}
