/**
 * Drive the real terminal stack under a real Electron runtime.
 *
 * The full app cannot be started right now without swapping better-sqlite3 to
 * the Electron ABI, and the user's app is live on the current binding. This
 * probe exercises everything that swap would have shown us *except* the harness
 * boot: node-pty inside Electron, the spawn-helper chmod, the real
 * `TerminalSessions`, the real preload bridge, and real xterm in a real window.
 *
 *   node scripts/terminal-probe.mjs          # headless
 *   PROBE_SHOW=1 node scripts/terminal-probe.mjs
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

// Re-exec under Electron when started with plain node, so the command above is
// the same either way.
if (process.versions.electron === undefined) {
  const electron = require("electron");
  const result = spawnSync(electron, [join(appDir, "scripts", "terminal-probe.mjs")], {
    stdio: "inherit",
    cwd: appDir,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  });
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow, ipcMain } = require("electron");
const { chmodSync, existsSync, statSync, writeFileSync, readFileSync } = await import("node:fs");
const { tmpdir } = await import("node:os");

const terminalModule = await import(
  new URL(`file://${join(appDir, "dist-electron", "terminal.js")}`).href
);
const {
  TerminalSessions,
  spawnHelperCandidates,
  parseOpenRequest,
  parseWriteRequest,
  parseResizeRequest,
} = terminalModule;

const results = [];
const record = (name, pass, detail = "") => {
  results.push({ name, pass: Boolean(pass), detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

// ---------------------------------------------------------------------------
// Main-process half

const ptyDir = dirname(require.resolve("node-pty/package.json"));
for (const helper of spawnHelperCandidates(ptyDir, process.platform, process.arch)) {
  if (existsSync(helper)) chmodSync(helper, 0o755);
}
const pty = require("node-pty");
record("node-pty loads inside Electron main", true, `electron ${process.versions.electron}`);

const ROOT = join(appDir, "..", "..");
const sessions = new TerminalSessions({
  platform: process.platform,
  env: process.env,
  isDirectory: (p) => existsSync(p) && statSync(p).isDirectory(),
  spawn: (file, args, options) => pty.spawn(file, [...args], options),
});

const events = [];
const opened = sessions.open({ terminalId: "term-1", cols: 80, rows: 24 }, ROOT, (e) => events.push(e));
record("opens a pty at the project root", opened.ok, opened.ok ? `pid ${opened.value.snapshot.pid}` : opened.error);
if (!opened.ok) process.exit(1);

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const output = () => events.filter((e) => e.type === "output").map((e) => e.data).join("");
const send = async (line, ms = 1300) => {
  sessions.write({ terminalId: "term-1", data: `${line}\r` }, ROOT);
  await settle(ms);
};
const windows = process.platform === "win32";

await settle(1500);
await send("echo PROBE_$((6*7))");
record("runs a command and streams its output", /PROBE_42/.test(output()));

// Printed on its own line so the command echo (which contains the literal
// `$ELECTRON_RUN_AS_NODE`) cannot be mistaken for the shell's answer.
await send(
  windows
    ? "[Console]::WriteLine('RAN=[{0}] TERMIS=[{1}]', $env:ELECTRON_RUN_AS_NODE, $env:TERM)"
    : "printf 'RAN=[%s] TERMIS=[%s]\\n' \"$ELECTRON_RUN_AS_NODE\" \"$TERM\"",
);
const envAnswer = /RAN=\[\] TERMIS=\[([^\]]*)\]/.exec(output());
record(
  "child does not inherit ELECTRON_RUN_AS_NODE",
  envAnswer !== null,
  envAnswer === null ? output().slice(-200).replace(/\r?\n/g, " | ") : "",
);
record(
  "TERM is xterm-256color, not whatever launchd set",
  envAnswer?.[1] === "xterm-256color",
  envAnswer?.[1] ?? "unset",
);

await send(
  windows
    ? "if (Get-Command pnpm -ErrorAction SilentlyContinue) { 'PNPM_ON_PATH' }"
    : "command -v pnpm >/dev/null && echo PNPM_ON_PATH",
  1800,
);
record("login shell assembles the user's PATH", /PNPM_ON_PATH/.test(output()), "command -v pnpm");

await send(windows ? "(Get-Location).Path" : "pwd");
record("shell starts at the project root", output().includes(ROOT), ROOT);

const beforeResize = output().length;
opened.value.detach();
await send("echo WHILE_DETACHED");
// Re-attach with a listener that keeps feeding `events`, or every check after
// this one would be reading a buffer that stopped growing at the detach.
const reattached = sessions.open({ terminalId: "term-1", cols: 80, rows: 24 }, ROOT, (e) =>
  events.push(e),
);
const replay = reattached.ok ? reattached.value.snapshot.history : "";
record(
  "re-attach replays scrollback written while detached",
  /WHILE_DETACHED/.test(replay) && /PROBE_42/.test(replay),
  `${replay.length} chars`,
);
record(
  "replayed scrollback carries no device queries",
  !/\[[0-9;?]*[nc]/.test(replay) && !/\]1[012];(\?|rgb:)/.test(replay),
);
record(
  "re-attach adopted the running shell rather than spawning another",
  reattached.ok && reattached.value.snapshot.pid === opened.value.snapshot.pid,
);

sessions.resize({ terminalId: "term-1", cols: 120, rows: 40 }, ROOT);
await settle(500);
await send(windows ? "$Host.UI.RawUI.WindowSize.Width" : "tput cols");
const resizeOutput = output().slice(beforeResize);
record(
  "resize reaches the shell",
  /\b120\b/.test(resizeOutput),
  /\b120\b/.test(resizeOutput)
    ? windows ? "$Host.UI.RawUI.WindowSize.Width" : "tput cols"
    : resizeOutput.slice(-240).replace(/\r?\n/g, " | "),
);

record(
  "rejects a traversal-shaped terminal id",
  parseOpenRequest({
    terminalId: "../x",
    attachmentId: "probe",
    cols: 80,
    rows: 24,
  }) === null,
);
record("rejects an oversized write", parseWriteRequest({ terminalId: "t", data: "x".repeat(70_000) }) === null);
record("rejects an out-of-range resize", parseResizeRequest({ terminalId: "t", cols: 0, rows: 24 }) === null);

// ---------------------------------------------------------------------------
// Renderer half: the real preload bridge, the real xterm, in a real window.

ipcMain.handle("daydream:terminal-open", (event, input) => {
  const request = parseOpenRequest(input);
  if (request === null) return { ok: false, error: "invalid terminal request" };
  const sender = event.sender;
  const o = sessions.open(request, ROOT, (payload) => {
    if (!sender.isDestroyed()) sender.send("daydream:terminal-event", payload);
  });
  return o.ok ? { ok: true, snapshot: o.value.snapshot } : { ok: false, error: o.error };
});
ipcMain.handle("daydream:terminal-write", (_e, input) => {
  const r = parseWriteRequest(input);
  if (r === null) return { ok: false, error: "invalid" };
  sessions.write(r, ROOT);
  return { ok: true };
});
ipcMain.handle("daydream:terminal-resize", (_e, input) => {
  const r = parseResizeRequest(input);
  if (r === null) return { ok: false, error: "invalid" };
  sessions.resize(r, ROOT);
  return { ok: true };
});
ipcMain.handle("daydream:terminal-detach", () => ({ ok: true }));
ipcMain.handle("daydream:terminal-close", () => ({ ok: true }));
ipcMain.handle("daydream:terminal-list", () => sessions.list(ROOT));

// Bundle the probe renderer through Vite so it resolves modules exactly as the
// app's own renderer does.
const outDir = join(tmpdir(), "daydream-terminal-probe");
const { build } = await import(new URL(`file://${require.resolve("vite")}`).href);
await build({
  configFile: false,
  root: appDir,
  logLevel: "error",
  build: {
    outDir,
    emptyOutDir: true,
    minify: false,
    lib: {
      entry: join(appDir, "scripts", "terminal-probe-renderer.mjs"),
      formats: ["iife"],
      name: "DaydreamTerminalProbe",
      fileName: () => "probe-renderer.js",
    },
  },
});

const page = join(outDir, "probe.html");
writeFileSync(
  page,
  `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<style>
${readFileSync(join(appDir, "node_modules/@xterm/xterm/css/xterm.css"), "utf8")}
:root { --accent: #3b6ef5; color-scheme: dark; }
html[data-theme="dark"] {
  --text-1: color-mix(in oklab, var(--accent) 3%, oklch(97% 0.004 265));
  --surface-1: color-mix(in oklab, var(--accent) 4%, oklch(21% 0.008 265));
  --accent-ink: color-mix(in oklab, var(--accent) 70%, oklch(80% 0.02 265));
  --ansi-1: light-dark(oklch(52% 0.19 25), oklch(70% 0.17 22));
  --ansi-2: light-dark(oklch(48% 0.15 155), oklch(78% 0.15 155));
}
body { margin: 0; background: var(--surface-1); }
#host { position: absolute; inset: 0; padding: 8px; }
</style></head><body><div id="host"></div>
<script>${readFileSync(join(outDir, "probe-renderer.js"), "utf8")}</script>
</body></html>`,
);

let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) console.log(failed.map((f) => `  FAILED: ${f.name} ${f.detail}`).join("\n"));
  sessions.disposeAll();
  setTimeout(() => {
    app.quit();
    process.exit(failed.length === 0 ? 0 : 1);
  }, 400);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 940,
    height: 600,
    show: process.env.PROBE_SHOW === "1",
    backgroundColor: "#1a1b1f",
    webPreferences: {
      preload: join(appDir, "dist-electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.on("console-message", (_e, _level, message) =>
    console.log(`  [renderer] ${message}`),
  );
  await win.loadFile(page);

  const deadline = Date.now() + 30_000;
  for (;;) {
    const done = await win.webContents.executeJavaScript("window.__probeDone === true");
    if (done) break;
    if (Date.now() > deadline) {
      record("renderer finished within the timeout", false);
      finish();
      return;
    }
    await settle(300);
  }
  const rendererChecks = await win.webContents.executeJavaScript("JSON.stringify(window.__probe)");
  for (const c of JSON.parse(rendererChecks)) record(c.name, c.pass, c.detail);

  if (process.env.PROBE_SHOW === "1") {
    const shot = await win.webContents.capturePage();
    writeFileSync(join(outDir, "terminal.png"), shot.toPNG());
    console.log(`  screenshot: ${join(outDir, "terminal.png")}`);
    await settle(1500);
  }
  finish();
});
