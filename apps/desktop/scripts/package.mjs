/**
 * Package the desktop app into installers with electron-builder.
 *
 *   node scripts/package.mjs [--publish always|never] [--arch arm64|x64]
 *
 * Expects the workspace already built (`pnpm exec tsc -b` at the root, then
 * `pnpm -C apps/desktop build`).
 *
 * electron-builder cannot package a pnpm workspace in place: the harness loads
 * its plugins by bare specifier at runtime (boot's loader resolves
 * `@daydream-code/<pkg>/<file>` from the app dir), so every workspace package
 * has to exist as a real directory under the app's node_modules, not as a
 * symlink out of the repo. `pnpm deploy` produces exactly that; the hoisted
 * linker makes the tree look like npm's, which electron-builder collects
 * reliably.
 *
 * better-sqlite3 in the staged tree carries a prebuild for host Node, so it is
 * swapped for the Electron prebuild of the target arch here rather than
 * letting electron-builder compile it from source. node-pty ships N-API
 * prebuilds for macOS and Windows and needs no rebuild.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(appDir, "..", "..");
const stageDir = join(appDir, "release", "stage");

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const publish = option("publish") ?? "never";
const arch = option("arch") ?? process.arch;

function run(command, commandArgs, cwd) {
  console.log(`[package] ${command} ${commandArgs.join(" ")}`);
  const result = spawnSync(command, commandArgs, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
}

for (const required of ["dist/index.html", "dist-electron/main.js"]) {
  if (!existsSync(join(appDir, required))) {
    console.error(`[package] ${required} is missing; run the desktop build first`);
    process.exit(1);
  }
}

rmSync(stageDir, { recursive: true, force: true });
run(
  "pnpm",
  [
    "--filter",
    "@daydream-code/desktop",
    "deploy",
    "--prod",
    "--config.node-linker=hoisted",
    stageDir,
  ],
  repoRoot,
);

const stageRequire = createRequire(pathToFileURL(join(stageDir, "package.json")));
const sqliteDir = dirname(stageRequire.resolve("better-sqlite3/package.json"));
const electronVersion = JSON.parse(
  readFileSync(
    createRequire(pathToFileURL(join(appDir, "package.json"))).resolve("electron/package.json"),
    "utf8",
  ),
).version;
const prebuildBin = createRequire(pathToFileURL(join(sqliteDir, "package.json"))).resolve(
  "prebuild-install/bin.js",
);
run(
  process.execPath,
  [prebuildBin, "--runtime=electron", `--target=${electronVersion}`, `--arch=${arch}`, "--force"],
  sqliteDir,
);

// Without a Developer ID certificate (CSC_LINK), sign ad hoc: an unsigned
// arm64 bundle whose Info.plist electron-builder rewrote will not launch at all.
const signing =
  process.platform === "darwin" && !process.env.CSC_LINK ? ["-c.mac.identity=-"] : [];

const builderBin =createRequire(pathToFileURL(join(appDir, "package.json"))).resolve(
  "electron-builder/cli.js",
);
run(
  process.execPath,
  [
    builderBin,
    "--projectDir",
    stageDir,
    "--config",
    join(appDir, "electron-builder.yml"),
    `--${arch}`,
    "--publish",
    publish,
    `-c.electronVersion=${electronVersion}`,
    `-c.directories.output=${join(appDir, "release")}`,
    ...signing,
  ],
  appDir,
);
