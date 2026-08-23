import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { App, type Context } from "@daydream-code/kernel";
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

export function composeLayers(options: BootOptions): {
  entries: ComposedEntry[];
  warnings: ComposeWarning[];
} {
  const projectRoot = resolve(options.projectRoot);
  const layers: Layer[] = [options.base ?? baseBundle(projectRoot)];
  const userConfig = fileLayer(
    join(homedir(), ".daydream-code", "config.yml"),
    "user:config.yml",
  );
  if (userConfig) layers.push(userConfig);
  const projectConfig = fileLayer(
    join(projectRoot, ".daydream-code", "config.yml"),
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
  return composeEntries(layers);
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
    mounted = await mountEntries(app.rootCtx, entries, [
      ...(options.resolutionPaths ?? []),
      resolve(options.projectRoot),
    ]);
    await app.settle();
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
