/**
 * Swap better-sqlite3's native binding between ABIs.
 *
 * The harness boots inside Electron's main process, but better-sqlite3 is
 * installed with a prebuild for the host Node ABI. pnpm shares one physical
 * copy across the workspace, so this script re-targets that copy:
 *
 *   node scripts/rebuild-native.mjs electron   # before `pnpm dev` / `start`
 *   node scripts/rebuild-native.mjs node       # before `pnpm exec vitest`
 *
 * Both directions download an official better-sqlite3 prebuild — no toolchain.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const appDir = join(dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[a-zA-Z]:)/, "")), "..");
const repoRoot = join(appDir, "..", "..");

const runtime = process.argv[2] ?? "electron";
if (runtime !== "electron" && runtime !== "node") {
  console.error("usage: node scripts/rebuild-native.mjs [electron|node]");
  process.exit(1);
}

// Resolve better-sqlite3 exactly as the store provider does.
const storeRequire = createRequire(
  pathToFileURL(join(repoRoot, "packages", "store", "package.json")),
);
const sqlitePkg = storeRequire.resolve("better-sqlite3/package.json");
const sqliteDir = dirname(sqlitePkg);

// prebuild-install lives in better-sqlite3's own dependency tree.
const sqliteRequire = createRequire(pathToFileURL(sqlitePkg));
const prebuildBin = sqliteRequire.resolve("prebuild-install/bin.js");

let target;
if (runtime === "electron") {
  const appRequire = createRequire(pathToFileURL(join(appDir, "package.json")));
  const electronPkg = appRequire.resolve("electron/package.json");
  target = JSON.parse(readFileSync(electronPkg, "utf8")).version;
} else {
  target = process.versions.node;
}

console.log(`[rebuild-native] better-sqlite3 → runtime=${runtime} target=${target}`);
const result = spawnSync(
  process.execPath,
  [prebuildBin, `--runtime=${runtime}`, `--target=${target}`, "--force", "--verbose"],
  { cwd: sqliteDir, stdio: "inherit" },
);
if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);

// prebuild-install overwrites the .node in place; macOS caches code signatures
// by inode, so after a swap the kernel SIGKILLs any process that dlopens the
// binding. Re-signing ad hoc invalidates the stale cache entry.
if (process.platform === "darwin") {
  const binding = join(sqliteDir, "build", "Release", "better_sqlite3.node");
  const sign = spawnSync("codesign", ["-f", "-s", "-", binding], { stdio: "inherit" });
  if ((sign.status ?? 1) !== 0) {
    console.warn("[rebuild-native] codesign failed; loading may SIGKILL until re-signed");
  }
}
process.exit(0);
