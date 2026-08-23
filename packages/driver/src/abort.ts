/**
 * Structural access to AbortSignal/AbortController members.
 *
 * Why: this workspace compiles with `lib: ["ES2023"]` (no DOM). @types/node
 * declares the abort globals behind `typeof globalThis extends { onmessage }`
 * conditionals; when an ambient Bun/DOM-ish type package leaks into the
 * program (e.g. a stray node_modules/@types above the repo), those globals
 * degrade to empty interfaces and direct member access stops type-checking.
 * The runtime objects are always real Node implementations, so we go through
 * narrow structural casts instead of the (environment-dependent) global types.
 */

interface SignalMembers {
  readonly aborted: boolean;
  addEventListener(
    type: string,
    listener: () => void,
    options?: { once?: boolean },
  ): void;
  removeEventListener(type: string, listener: () => void): void;
}

export function signalAborted(signal: AbortSignal): boolean {
  return (signal as unknown as SignalMembers).aborted;
}

/**
 * Invoke `listener` once when the signal aborts (immediately if it already
 * has). Returns a disposer that detaches the listener.
 */
export function onAbort(signal: AbortSignal, listener: () => void): () => void {
  const members = signal as unknown as SignalMembers;
  if (members.aborted) {
    listener();
    return () => {};
  }
  members.addEventListener("abort", listener, { once: true });
  return () => members.removeEventListener("abort", listener);
}

export function triggerAbort(controller: AbortController): void {
  (controller as unknown as { abort(reason?: unknown): void }).abort();
}
