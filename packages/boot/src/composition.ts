import { Service, type Context } from "@daydream-code/kernel";
import { composeEntries, type ComposedEntry, type ComposeWarning, type Layer } from "./entries.js";
import { mountEntries, resolvePlugin, type MountedEntry } from "./loader.js";

declare module "@daydream-code/kernel" {
  interface Context {
    composition: Composition;
  }
}

/**
 * The live composition: which entries are mounted, and the machinery to change
 * that while the app runs.
 *
 * This is deliberately mechanism-only. It will unload and remount any row it
 * is asked to, including ones that would take the whole app down with them —
 * deciding *which* rows are safe is policy, and policy lives in
 * `@daydream-code/settings`, where it can be replaced without touching the
 * loader.
 *
 * Mounted directly by `boot()` rather than through a config row, because it
 * has to exist before the rows do and it closes over values (the resolution
 * paths, the CLI overrides) that are runtime facts rather than settings.
 */
export class Composition extends Service {
  #mounted = new Map<string, MountedEntry>();
  #entries: ComposedEntry[] = [];
  #warnings: ComposeWarning[] = [];

  constructor(
    ctx: Context,
    /** Re-read the config layers from disk. Called fresh on every recompose. */
    readonly collect: () => Layer[],
    readonly resolutionPaths: readonly string[],
  ) {
    super(ctx, "composition");
  }

  /** The entries as last composed. */
  get entries(): readonly ComposedEntry[] {
    return this.#entries;
  }

  get warnings(): readonly ComposeWarning[] {
    return this.#warnings;
  }

  mountedEntry(id: string): MountedEntry | undefined {
    return this.#mounted.get(id);
  }

  /**
   * Load a row's module without mounting it, for reading its declarations.
   * Cached, because a settings view asks for every row on every request and
   * the module is already in the ESM registry after the first import anyway.
   */
  async describe(entry: ComposedEntry): Promise<unknown> {
    if (entry.name === undefined) return undefined;
    const mounted = this.#mounted.get(entry.id);
    if (mounted?.fiber?.plugin != null) return mounted.fiber.plugin;
    const cached = this.#described.get(entry.name);
    if (cached !== undefined) return cached;
    try {
      const plugin = await resolvePlugin(entry, this.resolutionPaths);
      this.#described.set(entry.name, plugin);
      return plugin;
    } catch {
      // A row pointing at a module that will not resolve is a real problem,
      // but it is the mounter's problem to report; describing it just fails.
      return undefined;
    }
  }

  #described = new Map<string, unknown>();

  /**
   * Record what `boot()` mounted. Separate from the constructor because the
   * rows are mounted *after* this service exists — they have to be, since a
   * row can inject it.
   */
  adopt(
    entries: ComposedEntry[],
    warnings: ComposeWarning[],
    mounted: Map<string, MountedEntry>,
  ): void {
    this.#entries = entries;
    this.#warnings = warnings;
    this.#mounted = mounted;
  }

  /** Re-read the layers and compose them, without mounting anything. */
  recompose(): { entries: ComposedEntry[]; warnings: ComposeWarning[] } {
    return composeEntries(this.collect());
  }

  /**
   * Replace what is mounted for one id. Unloads the old fiber first and waits
   * for it: a provider that is still holding its service name would make the
   * new one throw `DUPLICATE_SERVICE`, and the kernel's own unwinding of
   * dependents has to finish before the replacement can satisfy them again.
   */
  async replace(entry: ComposedEntry): Promise<MountedEntry> {
    await this.unmount(entry.id);
    const mounted = await mountEntries(
      this.ctx.registry.rootCtx,
      [entry],
      this.resolutionPaths,
    );
    const result = mounted.get(entry.id)!;
    this.#mounted.set(entry.id, result);
    this.#replaceEntry(entry);
    return result;
  }

  /** Unload the fiber for an id, leaving the row recorded as unmounted. */
  async unmount(id: string): Promise<void> {
    const previous = this.#mounted.get(id);
    if (previous?.fiber != null) {
      await this.ctx.registry.dispose(previous.fiber);
      await this.ctx.registry.settle();
    }
    this.#mounted.delete(id);
  }

  /** Drop a row entirely: unload it and forget the entry. */
  async remove(id: string): Promise<void> {
    await this.unmount(id);
    this.#entries = this.#entries.filter((entry) => entry.id !== id);
  }

  #replaceEntry(entry: ComposedEntry): void {
    const index = this.#entries.findIndex((existing) => existing.id === entry.id);
    if (index === -1) this.#entries.push(entry);
    else this.#entries[index] = entry;
  }

  /**
   * Adopt the warnings from a recompose. Entries are not taken wholesale here:
   * `replace` and `remove` already record what actually mounted, and a row the
   * caller declined to apply must keep the entry that is really running.
   */
  setWarnings(warnings: ComposeWarning[]): void {
    this.#warnings = warnings;
  }
}
