import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import type { Context, Fiber, Plugin } from "@daydream-code/kernel";
import type { ComposedEntry } from "./entries.js";

export interface MountedEntry {
  entry: ComposedEntry;
  fiber: Fiber | null;
  error?: unknown;
}

/**
 * Resolve a config entry to its plugin module.
 *
 * Exported because reading what a plugin *could* be configured with is not the
 * same as mounting it: a settings UI has to describe a disabled row, and
 * importing a module only evaluates its declarations — `apply` still runs only
 * when the kernel mounts it.
 */
export async function resolvePlugin(
  entry: ComposedEntry,
  resolutionPaths: readonly string[],
): Promise<Plugin> {
  const specifier = entry.name!;
  let target = specifier;
  if (specifier.startsWith("./") || specifier.startsWith("../") || isAbsolute(specifier)) {
    target = pathToFileURL(resolve(entry.baseDir, specifier)).href;
  } else {
    // Bare specifier: resolve from the host app / project, not from this
    // loader package (which deliberately depends on no providers).
    let lastError: unknown;
    for (const base of [...resolutionPaths, entry.baseDir]) {
      try {
        const req = createRequire(join(base, "noop.js"));
        target = pathToFileURL(req.resolve(specifier)).href;
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError !== undefined) {
      // Fall back to the loader's own context; let import() report the miss.
      target = specifier;
    }
  }
  const mod = (await import(target)) as Record<string, unknown>;
  const candidate = (mod.default ?? mod) as Plugin;
  if (
    typeof candidate === "function" ||
    (typeof candidate === "object" &&
      candidate !== null &&
      typeof (candidate as { apply?: unknown }).apply === "function")
  ) {
    return candidate;
  }
  throw new Error(
    `module "${specifier}" is not a plugin: expected a default export or an { apply } namespace`,
  );
}

/**
 * Mount composed entries onto a context. Resolution failures are loud (throw
 * after mounting everything else) — a missing module must never be a silent
 * no-op.
 */
export async function mountEntries(
  ctx: Context,
  entries: ComposedEntry[],
  resolutionPaths: readonly string[] = [],
): Promise<Map<string, MountedEntry>> {
  const mounted = new Map<string, MountedEntry>();
  const failures: string[] = [];
  for (const entry of entries) {
    if (entry.disabled || !entry.name) {
      mounted.set(entry.id, { entry, fiber: null });
      continue;
    }
    try {
      const plugin = await resolvePlugin(entry, resolutionPaths);
      let target = ctx;
      for (const name of entry.isolate ?? []) {
        target = target.isolate(name);
      }
      const fiber = target.plugin(plugin, entry.config);
      mounted.set(entry.id, { entry, fiber });
    } catch (error) {
      mounted.set(entry.id, { entry, fiber: null, error });
      failures.push(`- ${entry.id} (${entry.name}): ${String(error)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`failed to mount config entries:\n${failures.join("\n")}`);
  }
  return mounted;
}
