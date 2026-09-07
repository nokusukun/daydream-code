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
 * unless that project has a core retained by this app, because boot repair
 * only runs when a core starts: an unopened project's `running` rows may be
 * the residue of a crash. See `electron/stats.ts`.
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

/** A native menu opened from the read-only code workspace. */
export type CodeContextMenuRequest =
  | {
      kind: "selection";
      path: string;
      text: string;
      lineStart?: number;
      lineEnd?: number;
    }
  | {
      kind: "file";
      path: string;
      dir: boolean;
      expanded?: boolean;
    };

/** Actions that need renderer state; copy/reveal actions finish in Electron. */
export type CodeContextMenuAction = "ask-selection" | "open" | "toggle";

/** What the sidebar needs to know to draw a run's menu correctly. */
export interface SessionMenuRequest {
  id: string;
  name: string;
  archived: boolean;
  live: boolean;
  current: boolean;
}

/**
 * `null` means the person dismissed the menu, or cancelled the delete
 * confirmation — indistinguishable on purpose, since both mean do nothing.
 */
export type SessionMenuAction =
  | "open"
  | "archive"
  | "unarchive"
  | "delete"
  | "handoff"
  | "summarize";

/**
 * A quick action, as asked for. It never carries a path: the main process runs
 * it against whichever project is open, so the renderer cannot name a folder
 * it is not looking at.
 */
export type QuickActionRequest =
  | { kind: "reveal" }
  | { kind: "terminal" }
  | { kind: "command"; command: string };

/** `detail` is set when it worked but is still going (a server, an editor). */
export type QuickActionResult =
  | { ok: true; detail?: string }
  | { ok: false; error: string };

export interface TerminalOpenRequest {
  terminalId: string;
  attachmentId: string;
  cols: number;
  rows: number;
}

export interface TerminalAttachmentRequest {
  terminalId: string;
  attachmentId: string;
}

export interface TerminalWriteRequest {
  terminalId: string;
  data: string;
}

export interface TerminalResizeRequest {
  terminalId: string;
  cols: number;
  rows: number;
}

export interface TerminalSnapshot {
  terminalId: string;
  pid: number;
  cols: number;
  rows: number;
  /** Scrollback to replay, already stripped of sequences that would reply. */
  history: string;
  sequence: number;
  status: "running" | "exited";
}

export type TerminalOpenResult =
  | { ok: true; snapshot: TerminalSnapshot }
  | { ok: false; error: string };

export type TerminalAck = { ok: true } | { ok: false; error: string };

/**
 * Main describes these as a discriminated union, but this is the wire: the
 * fields are optional here because a payload from an older core is a value we
 * receive, not a type we control. Reading `data` off an `output` event is the
 * only thing the view does with it.
 */
export interface TerminalEvent {
  type: "output" | "exit";
  terminalId: string;
  sequence: number;
  data?: string;
  exitCode?: number;
  signal?: number | null;
}

export interface DaydreamBridge {
  getWindowState(): Promise<{ maximized: boolean }>;
  minimizeWindow(): Promise<void>;
  toggleMaximizeWindow(): Promise<void>;
  closeWindow(): Promise<void>;
  onWindowState(callback: (state: { maximized: boolean }) => void): () => void;
  getState(): Promise<{ connection: ConnectionInfo | null; recent: RegistryEntry[] }>;
  /** Every project core kept alive by the desktop process. */
  getProjectCores(): Promise<ConnectionInfo[]>;
  onProjectCores(callback: (connections: ConnectionInfo[]) => void): () => void;
  listProjects(): Promise<ProjectList>;
  openProject(rootPath: string): Promise<OpenResult>;
  pickProject(): Promise<OpenResult | null>;
  onConnection(callback: (info: ConnectionInfo) => void): () => void;
  /** Open (or focus) the settings window. */
  openSettings(): Promise<void>;
  getAppearance(): Promise<Appearance>;
  /**
   * Tell the OS which appearance the window should wear. The vibrancy material
   * behind the renderer is drawn by the window server, so an in-app theme is
   * only half applied until this lands.
   */
  setThemeSource(choice: "system" | "light" | "dark"): Promise<void>;
  onAppearance(callback: (appearance: Appearance) => void): () => void;
  /** Show the platform context menu for selected code or a file-tree row. */
  showCodeContextMenu(
    request: CodeContextMenuRequest,
  ): Promise<CodeContextMenuAction | null>;
  /** Show the platform Copy menu for selected read-only transcript text. */
  showTextContextMenu(text: string): Promise<void>;
  /** Show the platform menu for a run in the sidebar. Confirms Delete itself. */
  showSessionContextMenu(
    request: SessionMenuRequest,
  ): Promise<SessionMenuAction | null>;
  /** Reveal, open a terminal, or run a saved command at the project root. */
  runQuickAction(request: QuickActionRequest): Promise<QuickActionResult>;
  /**
   * Open a terminal at the project root, or adopt the one already running under
   * this id. The snapshot carries the scrollback to replay before live output.
   */
  openTerminal(request: TerminalOpenRequest): Promise<TerminalOpenResult>;
  writeTerminal(request: TerminalWriteRequest): Promise<TerminalAck>;
  resizeTerminal(request: TerminalResizeRequest): Promise<TerminalAck>;
  /** End the shell and discard its scrollback. */
  closeTerminal(terminalId: string): Promise<TerminalAck>;
  /** Stop receiving output without ending the shell. */
  detachTerminal(request: TerminalAttachmentRequest): Promise<TerminalAck>;
  listTerminals(): Promise<string[]>;
  onTerminalEvent(callback: (event: TerminalEvent) => void): () => void;
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
