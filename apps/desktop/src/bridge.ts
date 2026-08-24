/** Types for the preload-exposed IPC bridge (window.daydream). */

export interface ConnectionInfo {
  url: string;
  token: string;
  rootPath: string;
  name: string;
}

export interface RegistryEntry {
  rootPath: string;
  name: string;
  lastOpenedAt: string;
}

/**
 * OS-derived appearance. The renderer never picks its own accent or theme on
 * macOS: both come from System Settings so the app reads as native.
 */
export interface Appearance {
  /** #rrggbb from `systemPreferences.getAccentColor()`. */
  accent: string;
  dark: boolean;
  platform: string;
  /** True when the window is backed by a real vibrancy material. */
  vibrancy: boolean;
}

/**
 * What a project can honestly say about itself from outside. `live` is null
 * for every project except the open one, because boot repair only runs when a
 * project's core starts: a closed project's `running` rows may be the residue
 * of a crash. See `electron/stats.ts`.
 */
export interface ProjectStats {
  sessions: number;
  lastActivityAt: string | null;
  live: number | null;
}

export interface ProjectSummary extends RegistryEntry {
  /** False when the folder is gone. The row lists but cannot be opened. */
  exists: boolean;
  active: boolean;
  /** Null when the store is absent or unreadable. */
  stats: ProjectStats | null;
}

/**
 * `home` travels with the list so paths can print as `~/projects`. The
 * renderer has no filesystem of its own, and the value never changes.
 */
export interface ProjectList {
  home: string;
  projects: ProjectSummary[];
}

export type OpenResult =
  | { ok: true; connection: ConnectionInfo }
  | { ok: false; error: string };

export interface DaydreamBridge {
  getState(): Promise<{ connection: ConnectionInfo | null; recent: RegistryEntry[] }>;
  listProjects(): Promise<ProjectList>;
  openProject(rootPath: string): Promise<OpenResult>;
  pickProject(): Promise<OpenResult | null>;
  onConnection(callback: (info: ConnectionInfo) => void): () => void;
  /** Open (or focus) the settings window. */
  openSettings(): Promise<void>;
  getAppearance(): Promise<Appearance>;
  onAppearance(callback: (appearance: Appearance) => void): () => void;
}

declare global {
  interface Window {
    daydream?: DaydreamBridge;
  }
}

export function bridge(): DaydreamBridge | undefined {
  return window.daydream;
}

/** True when this renderer was loaded as the settings window (`#view=settings`). */
export function isSettingsWindow(): boolean {
  return new URLSearchParams(window.location.hash.replace(/^#/, "")).get("view") === "settings";
}

/**
 * Fallback for running the renderer outside Electron (plain browser against a
 * remote core): ?url=http://host:port&token=... — or the same params in the
 * hash (#url=...), which never reaches the dev server (Vite 403s request URLs
 * containing `//`).
 */
export function connectionFromQuery(): ConnectionInfo | null {
  const search = window.location.search;
  const hash = window.location.hash;
  const params = new URLSearchParams(
    search.length > 1 ? search : hash.replace(/^#/, ""),
  );
  const url = params.get("url");
  if (url === null || url.length === 0) return null;
  return {
    url,
    token: params.get("token") ?? "",
    rootPath: "(remote)",
    name: "remote core",
  };
}
