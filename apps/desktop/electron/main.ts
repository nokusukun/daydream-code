/**
 * Electron main process: project supervisor. Owns the project registry, boots
 * the harness in-process per project (server plugin on an ephemeral port with
 * a random bearer token), and hands the renderer only `{ url, token }` — the
 * renderer speaks HTTP/WS exclusively, so it could point at a remote core.
 */
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Inside the Electron runtime only CJS require("electron") is reliably
// intercepted (the ESM specifier can resolve to the npm path-wrapper under
// pnpm), so bridge through createRequire.
import { createRequire } from "node:module";
const electron =
  createRequire(import.meta.url)("electron") as typeof import("electron");
const { BrowserWindow, app: electronApp, dialog, ipcMain } = electron;
import { boot, type BootResult } from "@daydream-code/boot";
import type { HarnessServer } from "@daydream-code/server";
import {
  defaultRegistryPath,
  readRegistry,
  touchProject,
  writeRegistry,
  type RegistryEntry,
} from "./registry.js";

/** apps/desktop — bare plugin specifiers resolve from this package's deps. */
const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");

export interface ConnectionInfo {
  url: string;
  token: string;
  rootPath: string;
  name: string;
}

export type OpenResult =
  | { ok: true; connection: ConnectionInfo }
  | { ok: false; error: string };

interface ActiveProject {
  result: BootResult;
  connection: ConnectionInfo;
}

let active: ActiveProject | null = null;
/** Serializes open/dispose so two boots never race on one process. */
let chain: Promise<unknown> = Promise.resolve();

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

async function disposeActive(): Promise<void> {
  if (active === null) return;
  const prev = active;
  active = null;
  const { app } = prev.result;
  await app.dispose(app.rootFiber).catch((error: unknown) => {
    console.error("[desktop] dispose failed:", error);
  });
}

async function openProject(rootPath: string): Promise<ConnectionInfo> {
  await disposeActive();
  const token = randomBytes(16).toString("hex");
  const result = await boot({
    projectRoot: rootPath,
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
  await server.ready;

  const name = basename(rootPath) || rootPath;
  const connection: ConnectionInfo = { url: server.url, token, rootPath, name };
  active = { result, connection };

  if (process.env.DAYDREAM_SMOKE === undefined) {
    const registryFile = defaultRegistryPath();
    writeRegistry(registryFile, touchProject(readRegistry(registryFile), rootPath, name));
  }

  broadcast("daydream:connection", connection);
  return connection;
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

// ---------------------------------------------------------------------------
// IPC surface (mirrored by the preload bridge)

function registerIpc(): void {
  ipcMain.handle("daydream:get-state", () => ({
    connection: active?.connection ?? null,
    recent: readRegistry(defaultRegistryPath()) satisfies RegistryEntry[],
  }));

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

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    backgroundColor: "#0d1017",
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
    await disposeActive();
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
  const probe = (await win.webContents
    .executeJavaScript("document.querySelector('.shell') !== null")
    .catch(() => false)) as boolean;
  console.log(`[smoke:renderer] shell mounted: ${String(probe)}`);
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
  if (quitting || active === null) return;
  event.preventDefault();
  quitting = true;
  void disposeActive().finally(() => electronApp.exit(0));
});
