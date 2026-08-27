import type { ComponentType } from "react";

export type ModuleState = "loading" | "pending" | "active" | "failed";

export interface ModuleStatus {
  id: string;
  name: string;
  state: ModuleState;
  missing: readonly string[];
  error?: string;
}

export interface ModeContribution {
  id: string;
  label: string;
  order?: number;
  splitId: string;
  sidebar?: ComponentType;
  panel: ComponentType;
}

export interface OverlayContribution {
  id: string;
  order?: number;
  Component: ComponentType;
  command?: {
    label: string;
    hint?: string;
    order?: number;
  };
}

export interface ToolbarContribution<Host = unknown> {
  id: string;
  order?: number;
  position: "center" | "actions";
  Component: ComponentType<{ host: Host }>;
}

export interface DesktopModuleContext<Host = unknown> {
  readonly moduleId: string;
  effect(setup: () => void | (() => void), label?: string): () => void;
  registerMode(contribution: ModeContribution): () => void;
  registerOverlay(contribution: OverlayContribution): () => void;
  registerToolbar(contribution: ToolbarContribution<Host>): () => void;
}

export interface DesktopModule<Host = unknown> {
  id: string;
  name?: string;
  requires?: readonly string[];
  activate(context: DesktopModuleContext<Host>): void | (() => void);
}

export interface DesktopModuleLoader<Host = unknown> {
  id: string;
  name?: string;
  load(): Promise<{ default: DesktopModule<Host> }>;
}

interface Owned<T> {
  owner: string;
  value: T;
}

interface ModuleRecord<Host> {
  loader: DesktopModuleLoader<Host>;
  module: DesktopModule<Host> | undefined;
  state: ModuleState;
  missing: string[];
  error?: unknown;
  effects: Array<() => void>;
}

export interface DesktopModuleSnapshot<Host = unknown> {
  revision: number;
  modes: readonly ModeContribution[];
  overlays: readonly OverlayContribution[];
  toolbar: readonly ToolbarContribution<Host>[];
  statuses: readonly ModuleStatus[];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function byOrder<T extends { id: string; order?: number }>(a: T, b: T): number {
  return (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id);
}

/**
 * Renderer microkernel. A module activates transactionally: every registration
 * and side effect it creates is unwound when activation fails. Module imports
 * are also independent, so a top-level exception in one feature does not keep
 * the shell or its siblings from loading.
 */
export class DesktopModuleRuntime<Host = unknown> {
  #records = new Map<string, ModuleRecord<Host>>();
  #modes = new Map<string, Owned<ModeContribution>>();
  #overlays = new Map<string, Owned<OverlayContribution>>();
  #toolbar = new Map<string, Owned<ToolbarContribution<Host>>>();
  #listeners = new Set<() => void>();
  #revision = 0;
  #snapshot: DesktopModuleSnapshot<Host> = {
    revision: 0,
    modes: [],
    overlays: [],
    toolbar: [],
    statuses: [],
  };

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getSnapshot = (): DesktopModuleSnapshot<Host> => this.#snapshot;

  load(loaders: readonly DesktopModuleLoader<Host>[]): void {
    const loadable = new Set<string>();
    for (const loader of loaders) {
      const existing = this.#records.get(loader.id);
      if (existing !== undefined) {
        existing.state = "failed";
        existing.error = new Error(
          `desktop module "${loader.id}" has more than one loader`,
        );
        loadable.delete(loader.id);
        continue;
      }
      this.#records.set(loader.id, {
        loader,
        module: undefined,
        state: "loading",
        missing: [],
        effects: [],
      });
      loadable.add(loader.id);
    }
    this.#publish();
    for (const id of loadable) void this.#loadOne(id);
  }

  async retry(id: string): Promise<void> {
    const record = this.#records.get(id);
    if (record === undefined) return;
    this.#unwind(record);
    record.module = undefined;
    record.error = undefined;
    record.missing = [];
    record.state = "loading";
    this.#publish();
    await this.#loadOne(id);
  }

  dispose(): void {
    for (const record of [...this.#records.values()].reverse()) {
      this.#unwind(record);
    }
    this.#records.clear();
    this.#publish();
  }

  async #loadOne(id: string): Promise<void> {
    const record = this.#records.get(id);
    if (record === undefined) return;
    try {
      const loaded = await record.loader.load();
      if (loaded.default.id !== id) {
        throw new Error(
          `desktop module loader "${id}" returned "${loaded.default.id}"`,
        );
      }
      record.module = loaded.default;
      record.state = "pending";
      record.error = undefined;
    } catch (error) {
      record.state = "failed";
      record.error = error;
    }
    this.#settle();
    this.#publish();
  }

  #settle(): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const record of this.#records.values()) {
        if (record.state !== "pending" || record.module === undefined) continue;
        const requires = record.module.requires ?? [];
        record.missing = requires.filter(
          (id) => this.#records.get(id)?.state !== "active",
        );
        if (record.missing.length > 0) continue;
        this.#activate(record);
        changed = true;
      }
    }
  }

  #activate(record: ModuleRecord<Host>): void {
    const module = record.module!;
    const add = <T>(
      registry: Map<string, Owned<T>>,
      kind: string,
      id: string,
      value: T,
    ): (() => void) => {
      const existing = registry.get(id);
      if (existing !== undefined) {
        throw new Error(
          `${kind} "${id}" is already registered by desktop module "${existing.owner}"`,
        );
      }
      registry.set(id, { owner: module.id, value });
      const dispose = (): void => {
        if (registry.get(id)?.owner === module.id) registry.delete(id);
      };
      record.effects.push(dispose);
      return dispose;
    };

    const context: DesktopModuleContext<Host> = {
      moduleId: module.id,
      effect: (setup) => {
        const cleanup = setup() ?? (() => undefined);
        record.effects.push(cleanup);
        return cleanup;
      },
      registerMode: (contribution) =>
        add(this.#modes, "mode", contribution.id, contribution),
      registerOverlay: (contribution) =>
        add(this.#overlays, "overlay", contribution.id, contribution),
      registerToolbar: (contribution) =>
        add(
          this.#toolbar,
          "toolbar contribution",
          contribution.id,
          contribution,
        ),
    };

    try {
      const cleanup = module.activate(context);
      if (cleanup !== undefined) record.effects.push(cleanup);
      record.state = "active";
      record.missing = [];
    } catch (error) {
      this.#unwind(record);
      record.state = "failed";
      record.error = error;
    }
  }

  #unwind(record: ModuleRecord<Host>): void {
    for (const cleanup of record.effects.splice(0).reverse()) {
      try {
        cleanup();
      } catch (error) {
        console.error(
          `[desktop-module:${record.loader.id}] cleanup failed`,
          error,
        );
      }
    }
  }

  #publish(): void {
    this.#revision += 1;
    this.#snapshot = {
      revision: this.#revision,
      modes: [...this.#modes.values()].map(({ value }) => value).sort(byOrder),
      overlays: [...this.#overlays.values()]
        .map(({ value }) => value)
        .sort(byOrder),
      toolbar: [...this.#toolbar.values()]
        .map(({ value }) => value)
        .sort(byOrder),
      statuses: [...this.#records.entries()].map(([id, record]) => ({
        id,
        name: record.module?.name ?? record.loader.name ?? id,
        state: record.state,
        missing: record.missing,
        ...(record.error === undefined ? {} : { error: message(record.error) }),
      })),
    };
    for (const listener of this.#listeners) listener();
  }
}
