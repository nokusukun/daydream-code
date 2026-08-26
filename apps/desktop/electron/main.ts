/**
 * Electron main process: project supervisor. Owns the project registry, boots
 * the harness in-process per project (server plugin on an ephemeral port with
 * a random bearer token), and hands the renderer only `{ url, token }` — the
 * renderer speaks HTTP/WS exclusively, so it could point at a remote core.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Inside the Electron runtime only CJS require("electron") is reliably
// intercepted (the ESM specifier can resolve to the npm path-wrapper under
// pnpm), so bridge through createRequire.
import { createRequire } from "node:module";
const electron =
  createRequire(import.meta.url)("electron") as typeof import("electron");
const {
  BrowserWindow,
  Menu,
  app: electronApp,
  clipboard,
  dialog,
  ipcMain,
  nativeTheme,
  shell,
  systemPreferences,
} = electron;
import { boot, type BootResult } from "@daydream-code/boot";
import type { HarnessServer } from "@daydream-code/server";
import {
  defaultRegistryPath,
  readRegistry,
  touchProject,
  writeRegistry,
  type RegistryEntry,
} from "./registry.js";
import { summarizeProjects, type ProjectSummary } from "./stats.js";
import {
  runQuickAction,
  type QuickActionResult,
} from "./quick-actions.js";

/**
 * `home` travels with the list so the renderer can print `~/projects` the way
 * a Mac app does. The renderer has no filesystem, and asking for it separately
 * would be a second round trip for a value that never changes.
 */
export interface ProjectList {
  home: string;
  projects: ProjectSummary[];
}

/** apps/desktop — bare plugin specifiers resolve from this package's deps. */
const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP_NAME = "Daydream Code";

// Native menu roles use Electron's internal name for labels such as Hide and
// About. The top-level macOS application label is installed explicitly below.
electronApp.setName(APP_NAME);

export interface ConnectionInfo {
  url: string;
  token: string;
  rootPath: string;
  name: string;
}

export type OpenResult =
  | { ok: true; connection: ConnectionInfo }
  | { ok: false; error: string };

type CodeContextMenuAction = "ask-selection" | "open" | "toggle";

type CodeContextMenuRequest =
  | {
      kind: "selection";
      path: string;
      text: string;
      lineStart?: number;
      lineEnd?: number;
    }
  | { kind: "file"; path: string; dir: boolean; expanded?: boolean };

type SessionMenuAction = "open" | "archive" | "unarchive" | "delete";

interface SessionMenuRequest {
  id: string;
  name: string;
  /** Already shelved, so the menu offers the way back rather than the way in. */
  archived: boolean;
  /** Running or waiting: both destructive items are unavailable. */
  live: boolean;
  /** Already the open run, so "Open" would be a no-op. */
  current: boolean;
}

interface ActiveProject {
  result: BootResult;
  connection: ConnectionInfo;
}

/**
 * Every project opened during this app lifetime keeps its own core. Switching
 * changes which connection the workspace renders; it does not tear down work
 * that is still running in another project.
 */
const projects = new Map<string, ActiveProject>();
let activeRootPath: string | null = null;
/** Serializes boots so two opens never race on one process. */
let chain: Promise<unknown> = Promise.resolve();

function activeProject(): ActiveProject | null {
  return activeRootPath === null ? null : (projects.get(activeRootPath) ?? null);
}

function projectConnections(): ConnectionInfo[] {
  return [...projects.values()].map((project) => project.connection);
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

async function disposeProjects(): Promise<void> {
  const open = [...projects.values()];
  projects.clear();
  activeRootPath = null;
  await Promise.all(
    open.map(async ({ result, connection }) => {
      const { app } = result;
      await app.dispose(app.rootFiber).catch((error: unknown) => {
        console.error(`[desktop] dispose failed for ${connection.rootPath}:`, error);
      });
    }),
  );
}

async function openProject(rootPath: string): Promise<ConnectionInfo> {
  const normalizedRoot = resolve(rootPath);
  const retained = projects.get(normalizedRoot);
  if (retained !== undefined) {
    activeRootPath = normalizedRoot;
    touchRegistry(retained.connection);
    broadcast("daydream:connection", retained.connection);
    return retained.connection;
  }

  const token = randomBytes(16).toString("hex");
  const result = await boot({
    projectRoot: normalizedRoot,
    resolutionPaths: [appDir],
    overrides: [
      { id: "server", disabled: false, config: { port: 0, token } },
      // Make every driver in the composer dispatchable out of the box.
      { id: "driver-mock", disabled: false },
      { id: "driver-codex", disabled: false },
    ],
  });
  const server = result.ctx.server as
    | (HarnessServer & { ready: Promise<void> })
    | undefined;
  if (server === undefined) {
    const dump = result.app
      .dumpState()
      .filter((f) => f.state !== "active")
      .map((f) => `${f.state} ${f.name}${f.error ? `: ${f.error}` : ""}`)
      .join("; ");
    await result.app.dispose(result.app.rootFiber).catch(() => undefined);
    throw new Error(`server plugin did not come up (${dump || "no fiber info"})`);
  }
  try {
    await server.ready;
  } catch (error) {
    await result.app.dispose(result.app.rootFiber).catch(() => undefined);
    throw error;
  }

  const name = basename(normalizedRoot) || normalizedRoot;
  const connection: ConnectionInfo = {
    url: server.url,
    token,
    rootPath: normalizedRoot,
    name,
  };
  projects.set(normalizedRoot, { result, connection });
  activeRootPath = normalizedRoot;

  touchRegistry(connection);

  broadcast("daydream:project-cores", projectConnections());
  broadcast("daydream:connection", connection);
  return connection;
}

function touchRegistry(connection: ConnectionInfo): void {
  if (process.env.DAYDREAM_SMOKE !== undefined) return;
  const registryFile = defaultRegistryPath();
  writeRegistry(
    registryFile,
    touchProject(
      readRegistry(registryFile),
      connection.rootPath,
      connection.name,
    ),
  );
}

function openProjectSafe(rootPath: string): Promise<OpenResult> {
  const next = chain.then(async (): Promise<OpenResult> => {
    try {
      return { ok: true, connection: await openProject(rootPath) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  chain = next;
  return next;
}

/** Resolve an untrusted renderer path without letting the menu escape the project. */
function projectPath(value: unknown): { relative: string; absolute: string } | null {
  const active = activeProject();
  if (active === null || typeof value !== "string" || value.length === 0) return null;
  if (value.includes("\0")) return null;
  const root = resolve(active.connection.rootPath);
  const absolute = resolve(root, value);
  const fromRoot = relative(root, absolute);
  if (fromRoot === "" || fromRoot.startsWith("..") || isAbsolute(fromRoot)) return null;
  return { relative: value.replace(/\\/g, "/"), absolute };
}

function selectionReference(request: Extract<CodeContextMenuRequest, { kind: "selection" }>): string {
  const start = request.lineStart;
  const end = request.lineEnd;
  if (start === undefined) return request.path;
  return start === end || end === undefined
    ? `${request.path}:L${start}`
    : `${request.path}:L${Math.min(start, end)}-L${Math.max(start, end)}`;
}

/**
 * Native code-workspace menu. The main process owns filesystem actions and
 * clipboard writes; only actions that mutate renderer navigation come back.
 */
function showCodeContextMenu(
  event: Electron.IpcMainInvokeEvent,
  input: unknown,
): Promise<CodeContextMenuAction | null> {
  if (typeof input !== "object" || input === null) return Promise.resolve(null);
  const request = input as Partial<CodeContextMenuRequest>;
  const path = projectPath(request.path);
  const window = BrowserWindow.fromWebContents(event.sender);
  if (path === null || window === null) return Promise.resolve(null);

  let action: CodeContextMenuAction | null = null;
  let template: Electron.MenuItemConstructorOptions[];
  if (request.kind === "selection") {
    if (typeof request.text !== "string" || request.text.trim().length === 0) {
      return Promise.resolve(null);
    }
    // The file reader is clipped, but keep a hard IPC ceiling as well.
    const text = request.text.slice(0, 500_000);
    const normalized: Extract<CodeContextMenuRequest, { kind: "selection" }> = {
      kind: "selection",
      path: path.relative,
      text,
      ...(typeof request.lineStart === "number" ? { lineStart: request.lineStart } : {}),
      ...(typeof request.lineEnd === "number" ? { lineEnd: request.lineEnd } : {}),
    };
    const reference = selectionReference(normalized);
    template = [
      {
        label: "Copy",
        accelerator: "CommandOrControl+C",
        click: () => clipboard.writeText(text),
      },
      {
        label: "Copy with File Reference",
        click: () => clipboard.writeText(`${reference}\n${text}`),
      },
      { type: "separator" },
      { label: "Ask About Selection", click: () => { action = "ask-selection"; } },
    ];
  } else if (request.kind === "file" && typeof request.dir === "boolean") {
    template = [
      {
        label: request.dir
          ? request.expanded === true
            ? "Collapse Folder"
            : "Expand Folder"
          : "Open",
        click: () => { action = request.dir ? "toggle" : "open"; },
      },
      { type: "separator" },
      {
        label: "Copy Relative Path",
        click: () => clipboard.writeText(path.relative),
      },
      {
        label: "Copy Absolute Path",
        click: () => clipboard.writeText(path.absolute),
      },
      { type: "separator" },
      {
        label: process.platform === "darwin" ? "Reveal in Finder" : "Show in File Manager",
        click: () => shell.showItemInFolder(path.absolute),
      },
    ];
  } else {
    return Promise.resolve(null);
  }

  return new Promise((done) => {
    Menu.buildFromTemplate(template).popup({ window, callback: () => done(action) });
  });
}

/**
 * Native menu for a run in the sidebar.
 *
 * Delete confirms here rather than in the renderer: it is the only
 * irreversible thing the sidebar can do, and a native modal is both the
 * platform answer and the one dialog that cannot be dismissed by a re-render
 * happening underneath it. Everything the person needs to decide is in the
 * request, so main never reaches back into renderer state.
 */
function showSessionContextMenu(
  event: Electron.IpcMainInvokeEvent,
  input: unknown,
): Promise<SessionMenuAction | null> {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window === null || typeof input !== "object" || input === null) {
    return Promise.resolve(null);
  }
  const request = input as Partial<SessionMenuRequest>;
  const id = typeof request.id === "string" ? request.id : "";
  const name = typeof request.name === "string" ? request.name : id;
  if (id.length === 0) return Promise.resolve(null);
  const live = request.live === true;
  const archived = request.archived === true;

  let action: SessionMenuAction | null = null;
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "Open",
      enabled: request.current !== true,
      click: () => { action = "open"; },
    },
    { label: "Copy Name", click: () => clipboard.writeText(name) },
    { type: "separator" },
    {
      label: archived ? "Move to Sessions" : "Archive",
      // A live run is refused by the seam anyway; greying it out here explains
      // why instead of letting the click return a 409 the person never sees.
      enabled: !live,
      click: () => { action = archived ? "unarchive" : "archive"; },
    },
    {
      label: "Delete…",
      enabled: !live,
      click: () => { action = "delete"; },
    },
  ];

  return new Promise((done) => {
    Menu.buildFromTemplate(template).popup({
      window,
      callback: () => {
        if (action !== "delete") {
          done(action);
          return;
        }
        void dialog
          .showMessageBox(window, {
            type: "warning",
            buttons: ["Delete", "Cancel"],
            defaultId: 1,
            cancelId: 1,
            message: `Delete ${name}?`,
            detail:
              "Its transcript and journal are erased for good. Entries the master thread already wrote about it stay.",
          })
          .then((result) => done(result.response === 0 ? "delete" : null))
          .catch(() => done(null));
      },
    });
  });
}

/** Native Copy menu for selected prose in the agent and master timelines. */
function showTextContextMenu(
  event: Electron.IpcMainInvokeEvent,
  input: unknown,
): Promise<void> {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window === null || typeof input !== "string" || input.trim().length === 0) {
    return Promise.resolve();
  }
  const text = input.slice(0, 500_000);
  return new Promise((done) => {
    Menu.buildFromTemplate([
      {
        label: "Copy",
        accelerator: "CommandOrControl+C",
        click: () => clipboard.writeText(text),
      },
    ]).popup({ window, callback: done });
  });
}

/**
 * Electron has no automatic browser context menu. Install the native editing
 * roles once per window so every textarea and text input gets the same
 * platform behavior without renderer-specific handlers.
 */
function installEditableContextMenu(window: Electron.BrowserWindow): void {
  window.webContents.on("context-menu", (_event, params) => {
    if (!params.isEditable) return;
    const { editFlags } = params;
    Menu.buildFromTemplate([
      { role: "undo", enabled: editFlags.canUndo },
      { role: "redo", enabled: editFlags.canRedo },
      { type: "separator" },
      { role: "cut", enabled: editFlags.canCut },
      { role: "copy", enabled: editFlags.canCopy },
      { role: "paste", enabled: editFlags.canPaste },
      { type: "separator" },
      { role: "selectAll", enabled: editFlags.canSelectAll },
    ]).popup({ window });
  });
}

electronApp.on("browser-window-created", (_event, window) => {
  installEditableContextMenu(window);
});

// ---------------------------------------------------------------------------
// Appearance: the renderer paints with the OS accent + theme so the app reads
// as native rather than as a web page that picked its own blue.

const IS_MAC = process.platform === "darwin";

/** macOS default "multicolor" blue, used off-macOS and when the API is absent. */
const FALLBACK_ACCENT = "#0a84ff";

export interface Appearance {
  /** #rrggbb — the user's System Settings accent. */
  accent: string;
  dark: boolean;
  platform: NodeJS.Platform;
  /** Whether the window is backed by a real vibrancy material. */
  vibrancy: boolean;
}

/**
 * The window's vibrancy material takes its tone from the window's native
 * appearance, which follows `nativeTheme` — not from anything the renderer
 * writes into the document. So an in-app theme override has to be told to the
 * OS as well, or the CSS goes dark while the material behind it stays light
 * and the two disagree wherever the renderer is translucent.
 */
function setThemeSource(choice: unknown): void {
  if (choice === "light" || choice === "dark" || choice === "system") {
    nativeTheme.themeSource = choice;
  }
}

function readAppearance(): Appearance {
  let accent = FALLBACK_ACCENT;
  if (IS_MAC) {
    try {
      // Returns RRGGBBAA (no leading #); alpha is meaningless for our use.
      const raw = systemPreferences.getAccentColor();
      if (typeof raw === "string" && raw.length >= 6) accent = `#${raw.slice(0, 6)}`;
    } catch {
      // Older macOS or a locked-down environment: keep the fallback.
    }
  }
  return {
    accent,
    dark: nativeTheme.shouldUseDarkColors,
    platform: process.platform,
    vibrancy: IS_MAC,
  };
}

/** Push appearance to every window whenever macOS changes theme or accent. */
function watchAppearance(): void {
  const push = (): void => broadcast("daydream:appearance", readAppearance());
  nativeTheme.on("updated", push);
  if (IS_MAC) {
    try {
      systemPreferences.subscribeNotification(
        "AppleColorPreferencesChangedNotification",
        push,
      );
    } catch {
      // Notification unavailable; theme changes still propagate via nativeTheme.
    }
  }
}

// ---------------------------------------------------------------------------
// IPC surface (mirrored by the preload bridge)

function registerIpc(): void {
  ipcMain.handle("daydream:get-appearance", () => readAppearance());
  ipcMain.handle("daydream:set-theme-source", (_event, choice: unknown) => {
    setThemeSource(choice);
  });

  ipcMain.handle("daydream:code-context-menu", showCodeContextMenu);
  ipcMain.handle("daydream:text-context-menu", showTextContextMenu);
  ipcMain.handle("daydream:session-context-menu", showSessionContextMenu);

  /**
   * Quick actions run against the *open* project, and the request never says
   * which one: main owns that fact, so a renderer cannot ask for a folder it
   * is not looking at.
   */
  ipcMain.handle(
    "daydream:quick-action",
    async (_event, input: unknown): Promise<QuickActionResult> => {
      const active = activeProject();
      if (active === null) return { ok: false, error: "no project is open" };
      return runQuickAction(input, active.connection.rootPath, {
        platform: process.platform,
        env: process.env,
        spawn,
        openPath: (path: string) => shell.openPath(path),
      });
    },
  );

  ipcMain.handle("daydream:open-settings", () => {
    openSettingsWindow();
  });

  ipcMain.handle("daydream:get-state", () => ({
    connection: activeProject()?.connection ?? null,
    recent: readRegistry(defaultRegistryPath()) satisfies RegistryEntry[],
  }));

  /** Connections whose cores are alive in this process, for global activity. */
  ipcMain.handle("daydream:get-project-cores", () => projectConnections());

  /**
   * The switcher's data. Read on demand rather than cached: the numbers move
   * while the app is open, and reading a handful of small sqlite files costs
   * about a millisecond each. Every retained core may report live state;
   * `active` still marks only the project currently rendered in the workspace
   * (see stats.ts).
   */
  ipcMain.handle("daydream:list-projects", (): ProjectList => {
    const entries = readRegistry(defaultRegistryPath());
    return {
      home: homedir(),
      projects: summarizeProjects(
        entries,
        activeRootPath,
        new Set(projects.keys()),
      ),
    };
  });

  ipcMain.handle("daydream:open-project", (_event, rootPath: unknown) => {
    if (typeof rootPath !== "string" || rootPath.length === 0) {
      return { ok: false, error: "invalid project path" } satisfies OpenResult;
    }
    return openProjectSafe(rootPath);
  });

  ipcMain.handle("daydream:pick-project", async (): Promise<OpenResult | null> => {
    const picked = await dialog.showOpenDialog({
      title: "Open project folder",
      properties: ["openDirectory", "createDirectory"],
    });
    const rootPath = picked.filePaths[0];
    if (picked.canceled || rootPath === undefined) return null;
    return openProjectSafe(rootPath);
  });
}

// ---------------------------------------------------------------------------
// Window / lifecycle

/**
 * Temporary app mark: the facet the master thread already wears, on the same
 * tinted-navy ground the window surfaces are mixed from.
 *
 * Set at runtime rather than baked into a bundle because there is no packaging
 * step yet — unpackaged Electron shows its own icon in the Dock otherwise, and
 * `icon:` on BrowserWindow is a no-op on macOS. `icons/icon.icns` is here for
 * whenever the build config lands.
 */
function applyAppIcon(): void {
  const png = join(appDir, "icons", "icon.png");
  if (!existsSync(png)) return;
  if (IS_MAC) electronApp.dock?.setIcon(png);
}

/**
 * In development macOS takes the first menu-bar label from Electron.app's
 * bundle metadata, so `app.setName()` alone still renders "Electron". Own the
 * application menu and keep the platform-standard role menus intact.
 */
function installApplicationMenu(): void {
  if (!IS_MAC) return;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: APP_NAME,
        submenu: [
          { role: "about" },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { role: "fileMenu" },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
}

function createWindow(): void {
  const win = new BrowserWindow({
    title: APP_NAME,
    width: 1440,
    height: 900,
    minWidth: 880,
    minHeight: 560,
    // macOS: the window itself is the glass. The sidebar leaves it exposed;
    // the session panel paints an opaque surface over it. Off macOS the
    // renderer falls back to solid surfaces (see .no-vibrancy in styles.css).
    ...(IS_MAC
      ? {
          vibrancy: "sidebar" as const,
          visualEffectState: "followWindow" as const,
          backgroundColor: "#00000000",
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 19, y: 18 },
        }
      : { backgroundColor: "#16181d", icon: join(appDir, "icons", "icon.png") }),
    webPreferences: {
      preload: join(dirname(fileURLToPath(import.meta.url)), "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // The renderer only talks to the local harness server (random port,
      // bearer token); the server sends no CORS headers, so same-origin
      // policy is relaxed for this local tool window.
      webSecurity: true,
    },
  });
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl !== undefined && devUrl.length > 0) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(appDir, "dist", "index.html"));
  }
}

/**
 * The settings window.
 *
 * A real second window rather than a panel or a sheet, because settings are
 * not one of the three jobs the workspace exists to keep co-visible, and
 * hiding a running session to change a token budget is exactly the navigation
 * PRODUCT.md rules out. Singleton: asking twice focuses the one that is open.
 */
let settingsWindow: import("electron").BrowserWindow | null = null;

function openSettingsWindow(): void {
  if (settingsWindow !== null && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 860,
    height: 640,
    minWidth: 720,
    minHeight: 480,
    title: "settings",
    // Narrower chrome than the workspace: no traffic-light inset to dodge,
    // because the source list starts below the toolbar rather than beside it.
    ...(IS_MAC
      ? {
          vibrancy: "sidebar" as const,
          visualEffectState: "followWindow" as const,
          backgroundColor: "#00000000",
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 13, y: 15 },
        }
      : { backgroundColor: "#16181d", icon: join(appDir, "icons", "icon.png") }),
    webPreferences: {
      preload: join(dirname(fileURLToPath(import.meta.url)), "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  settingsWindow = win;
  win.on("closed", () => {
    settingsWindow = null;
  });
  // The hash, not a query param: Vite's dev server 403s request URLs that
  // contain `//`, and `connectionFromQuery` already reads the hash for the
  // same reason.
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl !== undefined && devUrl.length > 0) {
    void win.loadURL(`${devUrl}#view=settings`);
  } else {
    void win.loadFile(join(appDir, "dist", "index.html"), { hash: "view=settings" });
  }
}

/**
 * Headless smoke check (DAYDREAM_SMOKE=<projectRoot>): boot the harness
 * in-process, hit /health over HTTP, dispose, exit. No window — used to
 * verify the Electron-side boot path in CI-ish environments.
 */
async function runSmoke(rootPath: string): Promise<never> {
  try {
    await electronApp.whenReady();
    const connection = await openProject(rootPath);
    const response = await fetch(`${connection.url}/health`, {
      headers: { authorization: `Bearer ${connection.token}` },
    });
    const body: unknown = await response.json();
    console.log(`[smoke] ${connection.url} /health ${response.status} ${JSON.stringify(body)}`);
    let failures = response.ok ? 0 : 1;
    if (process.env.DAYDREAM_SMOKE_UI === "1") {
      failures += await smokeRenderer();
    }
    await disposeProjects();
    electronApp.exit(failures === 0 ? 0 : 1);
  } catch (error) {
    console.error("[smoke] FAILED:", error);
    electronApp.exit(1);
  }
  return new Promise<never>(() => undefined);
}

/** Load the built renderer in a hidden window; count renderer errors. */
async function smokeRenderer(): Promise<number> {
  registerIpc();
  watchAppearance();
  let errors = 0;
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: join(dirname(fileURLToPath(import.meta.url)), "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  win.webContents.on("console-message", (details) => {
    if (details.level === "error") {
      errors += 1;
      console.error(`[smoke:renderer] console error: ${details.message}`);
    } else {
      console.log(`[smoke:renderer] ${details.message}`);
    }
  });
  win.webContents.on("did-fail-load", (_e, code, description) => {
    errors += 1;
    console.error(`[smoke:renderer] did-fail-load ${code} ${description}`);
  });
  await win.loadFile(join(appDir, "dist", "index.html"));
  // Give the renderer time to call getState, fetch the timeline, open the WS.
  await new Promise((resolve) => setTimeout(resolve, 4000));
  // `.app` is the renderer's root element. This probe asked for `.shell`,
  // which no longer exists, so the UI smoke reported a failure on every run
  // and could not have caught a real one.
  const probe = (await win.webContents
    .executeJavaScript("document.querySelector('.app, .picker') !== null")
    .catch(() => false)) as boolean;
  console.log(`[smoke:renderer] renderer mounted: ${String(probe)}`);
  if (!probe) errors += 1;
  win.destroy();
  return errors;
}

const smokeRoot = process.env.DAYDREAM_SMOKE;
if (smokeRoot !== undefined && smokeRoot.length > 0) {
  void runSmoke(smokeRoot);
} else {
  registerIpc();
  void electronApp.whenReady().then(() => {
    installApplicationMenu();
    applyAppIcon();
    createWindow();
    electronApp.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

electronApp.on("window-all-closed", () => {
  electronApp.quit();
});

let quitting = false;
electronApp.on("will-quit", (event) => {
  if (quitting || projects.size === 0) return;
  event.preventDefault();
  quitting = true;
  void disposeProjects().finally(() => electronApp.exit(0));
});
