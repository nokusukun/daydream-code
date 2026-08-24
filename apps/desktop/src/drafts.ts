/**
 * Composer drafts: text that has been typed but not sent yet.
 *
 * Both composers are unmounted the moment you look somewhere else — the panel
 * is keyed by session id, and the new-session view disappears as soon as a row
 * is selected — so anything held in component state is gone on the next click.
 * This keeps that text outside React, one entry per composer, written through
 * to `localStorage` so it also survives a reload or a quit.
 *
 * Renderer-local by design: a draft is unsent keystrokes, not project state, so
 * it never touches the store or the journal. The consequence is that drafts do
 * not follow you to another machine pointed at the same core.
 *
 * A draft is text today, but both `POST /api/sessions` and `/message` already
 * take `attachments`, so a composer will eventually hold pending images too.
 * That is why the persisted value is an object rather than a bare string, and
 * why unknown fields on it are carried through a load/save untouched: adding
 * `attachments` later is a field, not a migration, and no one loses a draft
 * over it. There is a test pinning that.
 *
 * The store is deliberately storage-agnostic (same shape as `ApiClient`'s
 * injectable fetch) so it unit-tests without a DOM.
 */
import { useCallback, useSyncExternalStore } from "react";

/** Draft key for the not-yet-dispatched session; every other key is a session id. */
export const NEW_SESSION_DRAFT = "new";

/** The slice of the `Storage` interface this needs. */
export interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface DraftStoreOptions {
  /** Project scope, so two open projects never share a draft. */
  scope: string;
  /** Omit to use `window.localStorage`; pass null for a memory-only store. */
  storage?: StorageLike | null;
  now?: () => number;
  /** Coalescing window for writes. 0 writes synchronously on every keystroke. */
  writeDelayMs?: number;
  /** Oldest drafts past this count are dropped on load. */
  maxEntries?: number;
  /** Drafts untouched for longer than this are dropped on load. */
  maxAgeMs?: number;
}

interface Entry {
  text: string;
  at: number;
  /** Anything a later version wrote; preserved verbatim on rewrite. */
  rest?: Record<string, unknown>;
}

const PREFIX = "daydream.draft.";
const DEFAULT_WRITE_DELAY_MS = 400;
const DEFAULT_MAX_ENTRIES = 60;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function defaultStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Storage can throw on access under a locked-down origin.
    return null;
  }
}

function parseEntry(raw: string | null): Entry | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    if (!("text" in value) || typeof value.text !== "string") return null;
    const { text, at: rawAt, ...rest } = value as Record<string, unknown> & {
      text: string;
    };
    const at = typeof rawAt === "number" ? rawAt : 0;
    if (text.length === 0) return null;
    return Object.keys(rest).length === 0 ? { text, at } : { text, at, rest };
  } catch {
    return null;
  }
}

/**
 * One store per open project. Reads are synchronous off an in-memory map;
 * writes are coalesced, because a composer fires one `set` per keystroke and
 * `localStorage.setItem` is synchronous on the main thread.
 */
export class DraftStore {
  readonly #storage: StorageLike | null;
  readonly #prefix: string;
  readonly #now: () => number;
  readonly #writeDelayMs: number;
  readonly #entries = new Map<string, Entry>();
  readonly #dirty = new Set<string>();
  readonly #listeners = new Set<() => void>();
  #snapshot: ReadonlyMap<string, string> = new Map();
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: DraftStoreOptions) {
    this.#storage =
      options.storage === undefined ? defaultStorage() : options.storage;
    this.#prefix = `${PREFIX}${encodeURIComponent(options.scope)}.`;
    this.#now = options.now ?? (() => Date.now());
    this.#writeDelayMs = options.writeDelayMs ?? DEFAULT_WRITE_DELAY_MS;
    this.#hydrate(
      options.maxEntries ?? DEFAULT_MAX_ENTRIES,
      options.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
    );
    this.#resnapshot();
  }

  /** The draft for a composer, or "" when there is none. */
  get(key: string): string {
    return this.#entries.get(key)?.text ?? "";
  }

  /** Blank text clears the entry, so an emptied composer leaves nothing behind. */
  set(key: string, text: string): void {
    if (text.length === 0) {
      this.clear(key);
      return;
    }
    const current = this.#entries.get(key);
    if (current !== undefined && current.text === text) return;
    this.#entries.set(key, {
      text,
      at: this.#now(),
      ...(current?.rest !== undefined ? { rest: current.rest } : {}),
    });
    this.#touch(key);
  }

  clear(key: string): void {
    if (!this.#entries.delete(key)) return;
    this.#touch(key);
  }

  /** Keys that currently hold a draft, for the rail's unsent markers. */
  keys(): string[] {
    return [...this.#entries.keys()];
  }

  /** Stable per mutation, so `useSyncExternalStore` can compare by identity. */
  snapshot(): ReadonlyMap<string, string> {
    return this.#snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Write pending changes now. Call before the window goes away. */
  flush(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.#storage === null) {
      this.#dirty.clear();
      return;
    }
    for (const key of this.#dirty) {
      const entry = this.#entries.get(key);
      try {
        if (entry === undefined) this.#storage.removeItem(this.#prefix + key);
        else {
          const { rest, ...own } = entry;
          this.#storage.setItem(
            this.#prefix + key,
            JSON.stringify({ ...rest, ...own }),
          );
        }
      } catch {
        // A full or disabled quota costs persistence, never the keystroke.
      }
    }
    this.#dirty.clear();
  }

  #touch(key: string): void {
    this.#dirty.add(key);
    this.#resnapshot();
    for (const listener of [...this.#listeners]) listener();
    if (this.#writeDelayMs <= 0) {
      this.flush();
      return;
    }
    if (this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.flush();
    }, this.#writeDelayMs);
    // Never hold the process open for a draft write.
    (this.#timer as { unref?: () => void }).unref?.();
  }

  #resnapshot(): void {
    const next = new Map<string, string>();
    for (const [key, entry] of this.#entries) next.set(key, entry.text);
    this.#snapshot = next;
  }

  /**
   * Load this project's drafts, dropping unreadable, stale, and surplus ones.
   * Sessions are never deleted here, so entries would otherwise accumulate for
   * as long as the project exists; age and count are the bound.
   */
  #hydrate(maxEntries: number, maxAgeMs: number): void {
    const storage = this.#storage;
    if (storage === null) return;
    const found: Array<{ key: string; entry: Entry }> = [];
    const drop: string[] = [];
    const oldest = this.#now() - maxAgeMs;
    for (let i = 0; i < storage.length; i += 1) {
      const raw = storage.key(i);
      if (raw === null || !raw.startsWith(this.#prefix)) continue;
      const entry = parseEntry(storage.getItem(raw));
      if (entry === null || entry.at < oldest) {
        drop.push(raw);
        continue;
      }
      found.push({ key: raw.slice(this.#prefix.length), entry });
    }
    found.sort((a, b) => b.entry.at - a.entry.at);
    for (const surplus of found.splice(maxEntries)) {
      drop.push(this.#prefix + surplus.key);
    }
    for (const { key, entry } of found) this.#entries.set(key, entry);
    for (const raw of drop) {
      try {
        storage.removeItem(raw);
      } catch {
        // Same as above: pruning is housekeeping, not correctness.
      }
    }
  }
}

/**
 * One composer's draft, as a `useState`-shaped pair. The value lives in the
 * store, so the text is already there on the next mount.
 */
export function useDraft(
  store: DraftStore,
  key: string,
): [string, (text: string) => void] {
  const text = useSyncExternalStore(
    useCallback((listener) => store.subscribe(listener), [store]),
    useCallback(() => store.get(key), [store, key]),
  );
  const setText = useCallback(
    (next: string) => store.set(key, next),
    [store, key],
  );
  return [text, setText];
}

/** Every draft in the project, for views that mark which sessions have one. */
export function useDrafts(store: DraftStore): ReadonlyMap<string, string> {
  return useSyncExternalStore(
    useCallback((listener) => store.subscribe(listener), [store]),
    useCallback(() => store.snapshot(), [store]),
  );
}

/** First line of a draft, for a one-line preview in the rail. */
export function draftPreview(text: string, max = 80): string {
  const line = text.trim().split("\n", 1)[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
