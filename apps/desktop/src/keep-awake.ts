/**
 * Keep the screen awake while any loaded project has a live thread.
 *
 * The preference lives here, in localStorage, because it is a fact about this
 * machine's display, not about a project — the same scoping as the theme. The
 * decision ("does anyone want the screen held right now?") also lives in the
 * renderer, because only the renderer sees every loaded project's activity;
 * main just holds or releases the OS blocker it is told to.
 *
 * The wire carries `preference && anything-live` as one boolean, recomputed on
 * either input changing. Nothing is sent until the first `true`: main treats
 * an unheard-from window as not wanting the screen held, so announcing `false`
 * on every mount would be traffic that changes nothing.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { bridge } from "./bridge.js";
import { isLive } from "./sessions.js";
import type { ProjectActivity } from "./project-activity.js";
import { useProjectActivities } from "./project-fanout.js";

const STORAGE_KEY = "daydream.keep-awake";

export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStorage(): PreferenceStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Off unless explicitly turned on; an unreadable store must read as off. */
export function readKeepAwakePreference(
  storage: PreferenceStorage | null = browserStorage(),
): boolean {
  if (storage === null) return false;
  try {
    return storage.getItem(STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

export function writeKeepAwakePreference(
  enabled: boolean,
  storage: PreferenceStorage | null = browserStorage(),
): void {
  if (storage !== null) {
    try {
      storage.setItem(STORAGE_KEY, enabled ? "on" : "off");
    } catch {
      // Private or full storage must not make the toggle throw.
    }
  }
  for (const listener of listeners) listener();
}

// The toggle (app menu) and the driver (headless module) are separate
// components; a plain subscriber set keeps them agreeing without a provider.
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = (): boolean => readKeepAwakePreference();
// Static renders (tests) have no window; the default is the honest answer.
const getServerSnapshot = (): boolean => false;

export interface KeepAwakePreference {
  enabled: boolean;
  set(enabled: boolean): void;
}

export function useKeepAwakePreference(): KeepAwakePreference {
  const enabled = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return { enabled, set: writeKeepAwakePreference };
}

/** The one boolean the wire carries. Exported for tests. */
export function keepAwakeDesired(
  enabled: boolean,
  activities: readonly ProjectActivity[],
): boolean {
  return enabled && activities.some(({ session }) => isLive(session));
}

/**
 * Drive main's blocker from preference × activity. Renders nothing; mount it
 * anywhere under `ProjectFanoutProvider`.
 */
export function useKeepAwakeDriver(): void {
  const { enabled } = useKeepAwakePreference();
  const { activities } = useProjectActivities();
  const desired = keepAwakeDesired(enabled, activities);
  // What main currently believes about this window, so unmount knows whether
  // it owes a release and remounts (every project switch) send nothing.
  const told = useRef(false);

  useEffect(() => {
    if (told.current === desired) return;
    told.current = desired;
    // Optional call: a live app whose preload predates the channel simply
    // keeps its old behavior until the next full restart.
    void bridge()?.setKeepAwake?.(desired).catch(() => undefined);
  }, [desired]);

  useEffect(
    () => () => {
      if (!told.current) return;
      told.current = false;
      void bridge()?.setKeepAwake?.(false).catch(() => undefined);
    },
    [],
  );
}
