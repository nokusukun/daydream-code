/**
 * The project's quick actions, as the renderer holds them.
 *
 * These used to live in `localStorage`, which was right while a person was the
 * only author. A session is one now — `add_quick_action` puts a command in the
 * toolbar — and a harness tool runs in the core, where there is no window to
 * write to. So the list is the project's, served by `/api/actions`, and this
 * is a cache over it rather than a store of record.
 *
 * The cache re-reads on every open rather than holding what it fetched at
 * launch: the whole point is that something else can add to it while the
 * window is idle, and a menu showing yesterday's list would be hiding exactly
 * the row that makes this feature worth having.
 */
import { useEffect, useSyncExternalStore } from "react";
import type { QuickActionRecord } from "./api.js";

export type { QuickActionRecord } from "./api.js";

/** The slice of the API client this needs, so it unit-tests without one. */
export interface ActionsApi {
  actions(): Promise<QuickActionRecord[]>;
  addAction(input: { command: string; label?: string }): Promise<QuickActionRecord>;
  updateAction(
    id: string,
    patch: { command?: string; label?: string },
  ): Promise<QuickActionRecord>;
  removeAction(id: string): Promise<{ ok: true }>;
}

/** Rows written by the previous, renderer-local version of this feature. */
export const LEGACY_STORAGE_KEY = "daydream.quick-actions";

export interface StorageLike {
  getItem(key: string): string | null;
  removeItem(key: string): void;
}

function defaultStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Anything the old localStorage list held, as add inputs.
 *
 * It shipped for about an hour before the list moved into the project, so this
 * is a small debt — but a list of commands someone typed is exactly the kind
 * of thing that is annoying to lose and invisible when it goes. Dropped rows
 * are dropped, not repaired: the storage was editable by hand and outlived the
 * version that wrote it, so it is untrusted input like any other.
 */
export function legacyActions(raw: string | null): Array<{ command: string; label?: string }> {
  if (raw === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const out: Array<{ command: string; label?: string }> = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const { label, command } = item as Record<string, unknown>;
    if (typeof command !== "string" || command.trim().length === 0) continue;
    out.push({
      command,
      ...(typeof label === "string" && label.trim().length > 0 ? { label } : {}),
    });
  }
  return out;
}

export interface QuickActionStoreOptions {
  /** Omit for `window.localStorage`; pass null to skip the legacy adoption. */
  storage?: StorageLike | null;
}

export class QuickActionStore {
  readonly #api: ActionsApi;
  readonly #storage: StorageLike | null;
  readonly #listeners = new Set<() => void>();
  #actions: readonly QuickActionRecord[] = [];
  #adopted = false;

  constructor(api: ActionsApi, options: QuickActionStoreOptions = {}) {
    this.#api = api;
    this.#storage = options.storage === undefined ? defaultStorage() : options.storage;
  }

  /** Stable per mutation, so `useSyncExternalStore` can compare by identity. */
  snapshot(): readonly QuickActionRecord[] {
    return this.#actions;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Re-read the project's list. Failures leave the last good list in place. */
  async refresh(): Promise<void> {
    const list = await this.#api.actions();
    this.#commit(list);
    await this.#adoptLegacy(list);
  }

  async add(input: { command: string; label?: string }): Promise<QuickActionRecord> {
    const added = await this.#api.addAction(input);
    await this.refresh();
    return added;
  }

  async update(id: string, patch: { command?: string; label?: string }): Promise<void> {
    await this.#api.updateAction(id, patch);
    await this.refresh();
  }

  async remove(id: string): Promise<void> {
    await this.#api.removeAction(id);
    await this.refresh();
  }

  /**
   * Move rows from the old renderer-local list into the project, once.
   *
   * Only when the project has none: a project that already has actions has
   * been curated, and re-adding what someone deleted would be worse than
   * losing what they never migrated. The key is cleared whether or not every
   * row made it, because a retry would hit the same rejections.
   */
  async #adoptLegacy(current: readonly QuickActionRecord[]): Promise<void> {
    if (this.#adopted || this.#storage === null) return;
    this.#adopted = true;
    const raw = this.#storage.getItem(LEGACY_STORAGE_KEY);
    if (raw === null) return;
    if (current.length > 0) {
      this.#storage.removeItem(LEGACY_STORAGE_KEY);
      return;
    }
    const legacy = legacyActions(raw);
    for (const action of legacy) {
      try {
        await this.#api.addAction(action);
      } catch {
        // A row the project refuses (too long, past the cap) is one row lost,
        // not a reason to abandon the rest.
      }
    }
    this.#storage.removeItem(LEGACY_STORAGE_KEY);
    if (legacy.length > 0) this.#commit(await this.#api.actions());
  }

  #commit(next: readonly QuickActionRecord[]): void {
    this.#actions = next;
    for (const listener of this.#listeners) listener();
  }
}

/** Subscribe a component to the list. */
export function useQuickActions(store: QuickActionStore): readonly QuickActionRecord[] {
  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.snapshot(),
    () => store.snapshot(),
  );
}

/** Subscribe, and re-read whenever `active` becomes true (a menu opening). */
export function useQuickActionsLive(
  store: QuickActionStore,
  active: boolean,
): readonly QuickActionRecord[] {
  const actions = useQuickActions(store);
  useEffect(() => {
    if (active) void store.refresh().catch(() => undefined);
  }, [store, active]);
  return actions;
}
