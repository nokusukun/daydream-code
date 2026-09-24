/**
 * Find a project's own icon on disk, for the switcher.
 *
 * There is no manifest that names "the icon" of an arbitrary repo, so this
 * checks the places projects actually keep one, in order of how deliberately
 * the file is meant to be the project's face. Pure node, no Electron, so it
 * unit-tests against a temp folder.
 *
 * The result is a data URL rather than a path. The renderer is served from the
 * dev server's origin (or `file://` in a build), so a filesystem path would
 * load in one and not the other. The files are small and the switcher shows
 * four or five of them.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

/**
 * Square-by-design app icons. These win over web icons because a favicon is
 * often a 16px rendition of the thing an app icon draws at full size.
 */
const APP_ICONS = [
  "icon.svg",
  "icon.png",
  "icons/icon.svg",
  "icons/icon.png",
  "assets/icon.svg",
  "assets/icon.png",
  // Expo.
  "assets/images/icon.png",
  // electron-builder and Capacitor.
  "build/icon.png",
  "resources/icon.png",
  // Tauri. The @2x is 256px, plenty for a 22px mark and a tenth of icon.png.
  "src-tauri/icons/128x128@2x.png",
  "src-tauri/icons/icon.png",
];

/**
 * Web icons. apple-touch-icon first: it is the one a site ships at 180px on
 * an opaque background, which survives being drawn at mark size.
 */
const WEB_ICONS = [
  "public/apple-touch-icon.png",
  "public/icon.svg",
  "public/favicon.svg",
  "public/icon.png",
  "public/favicon.png",
  "public/favicon.ico",
  // Next's app router.
  "app/icon.svg",
  "app/icon.png",
  "app/apple-icon.png",
  "app/favicon.ico",
  "src/app/icon.svg",
  "src/app/icon.png",
  "src/app/apple-icon.png",
  "src/app/favicon.ico",
  // SvelteKit.
  "static/favicon.svg",
  "static/favicon.png",
  "static/favicon.ico",
  "favicon.svg",
  "favicon.png",
  "favicon.ico",
];

/** Last, because a logo is as often a wide wordmark as a mark. */
const LOGOS = [
  "logo.svg",
  "logo.png",
  "assets/logo.svg",
  "assets/logo.png",
  "public/logo.svg",
  "public/logo.png",
  ".github/logo.svg",
  ".github/logo.png",
  "docs/logo.svg",
  "docs/logo.png",
];

/**
 * An explicit override, for the project whose icon lives somewhere this list
 * will never guess. Same folder as the project's config and store.
 */
const OVERRIDES = [".daydream-code/icon.svg", ".daydream-code/icon.png"];

const TIERS: readonly (readonly string[])[] = [APP_ICONS, WEB_ICONS, LOGOS];

/** Monorepo containers whose children are the apps that carry the brand. */
const WORKSPACE_DIRS = ["apps"];
const MAX_WORKSPACES = 16;

/** Anything larger is a hero image or a source asset, not an icon. */
const MAX_BYTES = 512 * 1024;

const MIME: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function fileSize(path: string): number | null {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

/** `apps/<name>` folders, sorted so the pick does not depend on readdir order. */
function workspaceRoots(rootPath: string): string[] {
  const roots: string[] = [];
  for (const container of WORKSPACE_DIRS) {
    let names: string[];
    try {
      names = readdirSync(join(rootPath, container), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    names.sort();
    for (const name of names.slice(0, MAX_WORKSPACES)) {
      roots.push(join(rootPath, container, name));
    }
  }
  return roots;
}

/**
 * The path of the project's icon, or null. Tier-major: a web favicon at the
 * root does not beat an app icon inside `apps/desktop`, because the tier says
 * more about what the file is than its depth does.
 */
export function findProjectIcon(rootPath: string): string | null {
  for (const rel of OVERRIDES) {
    const path = join(rootPath, rel);
    const size = fileSize(path);
    if (size !== null && size > 0 && size <= MAX_BYTES) return path;
  }
  const roots = [rootPath, ...workspaceRoots(rootPath)];
  for (const tier of TIERS) {
    for (const root of roots) {
      for (const rel of tier) {
        const path = join(root, rel);
        const size = fileSize(path);
        if (size !== null && size > 0 && size <= MAX_BYTES) return path;
      }
    }
  }
  return null;
}

interface Encoded {
  mtimeMs: number;
  size: number;
  url: string;
}

/**
 * Encoded icons by file path. The switcher re-lists on every open, and
 * re-reading and base64-ing the same files each time is waste; the mtime and
 * size check means an edited icon still shows on the next open.
 */
const encoded = new Map<string, Encoded>();

function toDataUrl(path: string): string | null {
  const mime = MIME[extname(path).toLowerCase()];
  if (mime === undefined) return null;
  try {
    const stat = statSync(path);
    const hit = encoded.get(path);
    if (hit !== undefined && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
      return hit.url;
    }
    const url = `data:${mime};base64,${readFileSync(path).toString("base64")}`;
    encoded.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, url });
    return url;
  } catch {
    return null;
  }
}

/** The project's icon as a data URL, or null when it has none to find. */
export function projectIconUrl(rootPath: string): string | null {
  const path = findProjectIcon(rootPath);
  return path === null ? null : toDataUrl(path);
}
