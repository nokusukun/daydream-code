/**
 * Auto-update from GitHub Releases.
 *
 * Releases are published by `.github/workflows/release.yml` when a `v*` tag is
 * pushed; electron-builder writes `latest.yml` / `latest-mac.yml` next to the
 * installers, and electron-updater reads those to decide whether a newer
 * version exists.
 *
 * Windows goes through electron-updater end to end (download, then the NSIS
 * installer on quit). macOS does not: Squirrel.Mac refuses to install an update
 * unless both builds carry the same Developer ID signature, and these builds
 * are signed ad hoc. So on macOS electron-updater only *checks*, and this
 * module downloads the release zip, verifies its sha512 against the manifest,
 * and swaps the bundle in place from a detached script after the app exits.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, createWriteStream, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createRequire } from "node:module";
import type { UpdateInfo } from "electron-updater";

const require = createRequire(import.meta.url);
const { app, dialog, shell } = require("electron") as typeof import("electron");

const REPO = "nokusukun/daydream-code";
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 15_000;

type Pending =
  | { kind: "windows" }
  | { kind: "mac"; version: string; stagedApp: string; bundle: string };

let pending: Pending | null = null;
let checking = false;
let downloadingMac: string | null = null;
let prompted: string | null = null;

// electron-updater constructs the platform updater on first access and reads
// app-update.yml from the bundle; neither exists in an unpackaged dev run.
function updater(): import("electron-updater").AppUpdater {
  return (require("electron-updater") as typeof import("electron-updater")).autoUpdater;
}

/** Start the background check loop. No-op outside a packaged build. */
export function startAutoUpdates(): void {
  if (!app.isPackaged || process.env.DAYDREAM_DISABLE_UPDATES === "1") return;
  if (process.platform !== "darwin" && process.platform !== "win32") return;

  const autoUpdater = updater();
  autoUpdater.autoDownload = process.platform === "win32";
  // Installing on quit is applyPendingUpdateOnExit's job; see its comment.
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = console;

  autoUpdater.on("error", (error) => console.error("[updater]", error));
  autoUpdater.on("update-downloaded", (info) => {
    pending = { kind: "windows" };
    void promptRestart(info.version);
  });
  if (process.platform === "darwin") {
    autoUpdater.on("update-available", (info) => {
      void downloadMacUpdate(info).catch((error: unknown) => {
        console.error("[updater] mac update failed:", error);
      });
    });
  }

  setTimeout(() => void checkForUpdates(false), FIRST_CHECK_DELAY_MS).unref();
  setInterval(() => void checkForUpdates(false), CHECK_INTERVAL_MS).unref();
}

/**
 * Check now. `interactive` is the menu item: it reports "up to date" and
 * failures in a dialog, where the background loop stays silent.
 */
export async function checkForUpdates(interactive: boolean): Promise<void> {
  if (!app.isPackaged) {
    if (interactive) {
      void dialog.showMessageBox({ message: "Updates are only available in packaged builds." });
    }
    return;
  }
  if (pending !== null) {
    if (interactive) void promptRestart(pendingVersion() ?? "");
    return;
  }
  if (checking) return;
  checking = true;
  try {
    const result = await updater().checkForUpdates();
    if (interactive && (result === null || !result.isUpdateAvailable)) {
      void dialog.showMessageBox({
        message: "Daydream Code is up to date.",
        detail: `Version ${app.getVersion()}`,
      });
    } else if (interactive) {
      void dialog.showMessageBox({
        message: `Downloading version ${result!.updateInfo.version}…`,
        detail: "You'll be asked to restart when it's ready.",
      });
    }
  } catch (error) {
    console.error("[updater] check failed:", error);
    if (interactive) {
      void dialog.showMessageBox({
        type: "error",
        message: "Could not check for updates.",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    checking = false;
  }
}

/**
 * Called from the app's will-quit path, which ends in `app.exit()` — that skips
 * the `quit` event electron-updater's own install-on-quit listens for, so a
 * downloaded update would otherwise never be applied.
 */
export function applyPendingUpdateOnExit(): void {
  if (pending === null) return;
  if (pending.kind === "windows") {
    updater().quitAndInstall(true, false);
  } else {
    swapMacBundle(pending, false);
  }
  pending = null;
}

function pendingVersion(): string | null {
  return pending?.kind === "mac" ? pending.version : null;
}

async function promptRestart(version: string): Promise<void> {
  // One prompt per version: the background loop re-finds the same release.
  if (prompted === version) return;
  prompted = version;
  const { response } = await dialog.showMessageBox({
    type: "info",
    buttons: ["Restart Now", "Later"],
    defaultId: 0,
    cancelId: 1,
    message: version ? `Daydream Code ${version} is ready to install.` : "An update is ready to install.",
    detail: "Restart now, or it will be installed the next time you quit.",
  });
  if (response !== 0 || pending === null) return;
  const update = pending;
  pending = null;
  if (update.kind === "windows") {
    updater().quitAndInstall(true, true);
  } else {
    swapMacBundle(update, true);
    app.quit();
  }
}

// ---------------------------------------------------------------------------
// macOS

/** `/Applications/Daydream Code.app` from `…/Contents/MacOS/Daydream Code`. */
function currentBundle(): string {
  return dirname(dirname(dirname(process.execPath)));
}

async function downloadMacUpdate(info: UpdateInfo): Promise<void> {
  if (downloadingMac === info.version) return;
  // Swapping needs write access next to the bundle. A copy run from the
  // mounted DMG, or one Gatekeeper translocated, cannot be replaced in place.
  const bundle = currentBundle();
  try {
    if (bundle.startsWith("/Volumes/") || bundle.includes("/AppTranslocation/")) throw new Error();
    accessSync(dirname(bundle), constants.W_OK);
  } catch {
    if (prompted === info.version) return;
    prompted = info.version;
    const { response } = await dialog.showMessageBox({
      type: "info",
      buttons: ["Download", "Later"],
      defaultId: 0,
      cancelId: 1,
      message: `Daydream Code ${info.version} is available.`,
      detail: "This copy can't update itself in place. Move it to Applications, or download the new version.",
    });
    if (response === 0) void shell.openExternal(`https://github.com/${REPO}/releases/latest`);
    return;
  }
  downloadingMac = info.version;
  try {
    await stageMacUpdate(info, bundle);
  } finally {
    downloadingMac = null;
  }
}

async function stageMacUpdate(info: UpdateInfo, bundle: string): Promise<void> {
  const file = info.files.find(
    (candidate) => candidate.url.endsWith(".zip") && candidate.url.includes(process.arch),
  ) ?? info.files.find((candidate) => candidate.url.endsWith(".zip"));
  if (file === undefined) throw new Error(`release ${info.version} has no zip for macOS`);

  const url = /^https?:/.test(file.url)
    ? file.url
    : `https://github.com/${REPO}/releases/download/v${info.version}/${encodeURIComponent(file.url)}`;
  const workDir = mkdtempSync(join(tmpdir(), "daydream-update-"));
  const zipPath = join(workDir, "update.zip");

  const response = await fetch(url);
  if (!response.ok || response.body === null) {
    throw new Error(`download failed: ${response.status} ${url}`);
  }
  const hash = createHash("sha512");
  const body = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
  body.on("data", (chunk: Buffer) => hash.update(chunk));
  await pipeline(body, createWriteStream(zipPath));
  if (file.sha512 && hash.digest("base64") !== file.sha512) {
    rmSync(workDir, { recursive: true, force: true });
    throw new Error("downloaded update failed its sha512 check");
  }

  // ditto, not unzip: it preserves the symlinks and extended attributes an
  // app bundle's frameworks depend on.
  const extractDir = join(workDir, "app");
  await run("/usr/bin/ditto", ["-x", "-k", zipPath, extractDir]);
  const appName = readdirSync(extractDir).find((entry) => entry.endsWith(".app"));
  if (appName === undefined) throw new Error("update zip contained no .app bundle");

  pending = {
    kind: "mac",
    version: info.version,
    stagedApp: join(extractDir, appName),
    bundle,
  };
  await promptRestart(info.version);
}

/**
 * Replace the running bundle once this process has exited, then optionally
 * relaunch. Runs detached so it outlives us; a failed move restores the old
 * bundle rather than leaving the user with no app.
 */
function swapMacBundle(update: Extract<Pending, { kind: "mac" }>, relaunch: boolean): void {
  if (!existsSync(update.stagedApp)) return;
  const script = join(dirname(update.stagedApp), "swap.sh");
  writeFileSync(
    script,
    `#!/bin/sh
while kill -0 "$1" 2>/dev/null; do sleep 0.2; done
target="$2"; staged="$3"; backup="$target.old-$$"
mv "$target" "$backup" || exit 1
if mv "$staged" "$target"; then
  rm -rf "$backup"
  xattr -dr com.apple.quarantine "$target" 2>/dev/null
else
  mv "$backup" "$target"
fi
if [ "$4" = "1" ]; then open "$target"; fi
`,
    { mode: 0o755 },
  );
  spawn("/bin/sh", [script, String(process.pid), update.bundle, update.stagedApp, relaunch ? "1" : "0"], {
    detached: true,
    stdio: "ignore",
  }).unref();
}

function run(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)),
    );
  });
}
