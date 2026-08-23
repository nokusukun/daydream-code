/**
 * Dev runner: compile the electron main once, start the Vite dev server, then
 * launch Electron pointed at it via ELECTRON_RENDERER_URL.
 */
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import electronPath from "electron";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");

console.log("[dev] building electron main…");
const tsc = spawnSync("pnpm exec tsc -b tsconfig.electron.json", {
  cwd: appDir,
  stdio: "inherit",
  shell: true,
});
if (tsc.status !== 0) process.exit(tsc.status ?? 1);

console.log("[dev] starting vite…");
const server = await createServer({ configFile: join(appDir, "vite.config.ts"), root: appDir });
await server.listen();
const url = server.resolvedUrls?.local[0];
if (url === undefined) {
  console.error("[dev] vite did not report a local url");
  process.exit(1);
}
console.log(`[dev] renderer at ${url}`);

const child = spawn(String(electronPath), [join(appDir, "dist-electron", "main.js")], {
  stdio: "inherit",
  env: { ...process.env, ELECTRON_RENDERER_URL: url },
});
child.on("exit", (code) => {
  void server.close().finally(() => process.exit(code ?? 0));
});
