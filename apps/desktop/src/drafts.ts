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
 * A draft is text plus any images attached to it. The images are references —
 * blob ids the store already holds, uploaded when they were pasted — never
 * bytes: `localStorage` is a few megabytes for the whole origin, which one
 * screenshot in base64 would eat. That the persisted value was always an
 * object is why this arrived as a field rather than a migration, and unknown
 * fields are still carried through a load/save untouched so the next one is
 * free too. There are tests pinning both.
 *
 * The store is deliberately storage-agnostic (same shape as `ApiClient`'s
 * injectable fetch) so it unit-tests without a DOM.
 */
import { useCallback, useSyncExternalStore } from "react";
import { attachmentSummary, type Attachment } from "./attachments.js";

/** What one composer is holding: unsent text, and images already uploaded. */
export interface Draft {
  text: string;
  attachments: Attachment[];
}

/** The one empty draft. Shared so "has nothing" is an identity comparison. */
export const EMPTY_DRAFT: Draft = { text: "", attachments: [] };

/** True when there is nothing worth keeping — no text and no images. */
export function isEmptyDraft(draft: Draft): boolean {
  return draft.text.length === 0 && draft.attachments.length === 0;
}

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
  attachments: Attachment[];
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

/**
 * Attachments as they were persisted, minus anything that is not one.
 *
 * A stored draft is untrusted input — it outlives the version that wrote it
 * and is editable by hand — and a malformed entry here would reach an `<img>`
 * and a dispatch body. A bad element is dropped rather than failing the whole
 * draft: losing one chip beats losing the paragraph it was attached to.
 */
function parseAttachments(value: unknown): Attachment[] {
  if (!Array.isArray(value)) return [];
  const kept: Attachment[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.blobId !== "string" || record.blobId.length === 0) continue;
    if (typeof record.mediaType !== "string") continue;
    kept.push({
      blobId: record.blobId,
      mediaType: record.mediaType,
      bytes: typeof record.bytes === "number" ? record.bytes : 0,
      ...(typeof record.width === "number" ? { width: record.width } : {}),
      ...(typeof record.height === "number" ? { height: record.height } : {}),
      ...(typeof record.name === "string" ? { name: record.name } : {}),
    });
  }
  return kept;
}

function parseEntry(raw: string | null): Entry | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    if (!("text" in value) || typeof value.text !== "string") return null;
    const {
      text,
      at: rawAt,
      attachments: rawAttachments,
      ...rest
    } = value as Record<string, unknown> & { text: string };
    const at = typeof rawAt === "number" ? rawAt : 0;
    const attachments = parseAttachments(rawAttachments);
    // An image with no caption is still a draft; only the empty one is not.
    if (text.length === 0 && attachments.length === 0) return null;
    return Object.keys(rest).length === 0
      ? { text, attachments, at }
      : { text, attachments, at, rest };
  } catch {
    return null;
  }
}

/** Attachments are compared by id: a draft never edits one in place. */
function sameAttachments(a: Attachment[], b: Attachment[]): boolean {
  return (
    a.length === b.length && a.every((item, i) => item.blobId === b[i]?.blobId)
  );
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
  #snapshot: ReadonlyMap<string, Draft> = new Map();
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

  /**
   * The draft for a composer, or an empty one when there is none.
   *
   * Read off the snapshot rather than rebuilt, because this is what
   * `useSyncExternalStore` calls: a fresh object per call is a value React
   * compares by identity, and it would re-render on every commit forever.
   */
  get(key: string): Draft {
    return this.#snapshot.get(key) ?? EMPTY_DRAFT;
  }

  /** An empty draft clears the entry, so a cleared composer leaves nothing behind. */
  set(key: string, draft: Draft): void {
    if (isEmptyDraft(draft)) {
      this.clear(key);
      return;
    }
    const current = this.#entries.get(key);
    if (
      current !== undefined &&
      current.text === draft.text &&
      sameAttachments(current.attachments, draft.attachments)
    ) {
      return;
    }
    this.#entries.set(key, {
      text: draft.text,
      attachments: draft.attachments,
      at: this.#now(),
      ...(current?.rest !== undefined ? { rest: current.rest } : {}),
    });
    this.#touch(key);
  }

  /**
   * Add an image to a draft, or drop one by id.
   *
   * Mutators rather than a read-modify-write at the call site because an
   * upload finishes on its own schedule: the composer that started it may
   * already be unmounted (you switched sessions while it was in flight), and
   * anything holding the old draft in a closure would write back a stale one.
   * The store is the thing that outlives the view, so the merge belongs here.
   */
  attach(key: string, attachment: Attachment): void {
    const draft = this.get(key);
    if (draft.attachments.some((a) => a.blobId === attachment.blobId)) return;
    this.set(key, {
      text: draft.text,
      attachments: [...draft.attachments, attachment],
    });
  }

  detach(key: string, blobId: string): void {
    const draft = this.get(key);
    const attachments = draft.attachments.filter((a) => a.blobId !== blobId);
    if (attachments.length === draft.attachments.length) return;
    this.set(key, { text: draft.text, attachments });
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
  snapshot(): ReadonlyMap<string, Draft> {
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
          const { rest, attachments, ...own } = entry;
          this.#storage.setItem(
            this.#prefix + key,
            // Omitted when empty, so a text-only draft is written exactly as
            // the version before this one wrote it.
            JSON.stringify({
              ...rest,
              ...own,
              ...(attachments.length > 0 ? { attachments } : {}),
            }),
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

  /**
   * Rebuild the snapshot, keeping the previous object for every draft that did
   * not actually change. Identity is what every subscriber compares on, so
   * allocating fresh values here would re-render every rail row on each
   * keystroke in an unrelated composer.
   */
  #resnapshot(): void {
    const previous = this.#snapshot;
    const next = new Map<string, Draft>();
    for (const [key, entry] of this.#entries) {
      const before = previous.get(key);
      const unchanged =
        before !== undefined &&
        before.text === entry.text &&
        sameAttachments(before.attachments, entry.attachments);
      next.set(
        key,
        unchanged
          ? before
          : { text: entry.text, attachments: entry.attachments },
      );
    }
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
): [Draft, (next: Draft) => void] {
  const draft = useSyncExternalStore(
    useCallback((listener) => store.subscribe(listener), [store]),
    useCallback(() => store.get(key), [store, key]),
  );
  const setDraft = useCallback(
    (next: Draft) => store.set(key, next),
    [store, key],
  );
  return [draft, setDraft];
}

/** Every draft in the project, for views that mark which sessions have one. */
export function useDrafts(store: DraftStore): ReadonlyMap<string, Draft> {
  return useSyncExternalStore(
    useCallback((listener) => store.subscribe(listener), [store]),
    useCallback(() => store.snapshot(), [store]),
  );
}

/**
 * One line for the rail: the first line of the text, or what is attached when
 * there is no text. An image-only draft is still a draft, and a row that said
 * nothing about it would look like an empty one.
 */
export function draftPreview(draft: Draft | undefined, max = 80): string {
  if (draft === undefined) return "";
  const line = draft.text.trim().split("\n", 1)[0] ?? "";
  if (line.length === 0) {
    return draft.attachments.length > 0
      ? attachmentSummary(draft.attachments.length)
      : "";
  }
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
