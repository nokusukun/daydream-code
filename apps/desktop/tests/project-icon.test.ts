import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findProjectIcon, projectIconUrl } from "../electron/project-icon.js";

const dirs: string[] = [];

function project(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), "daydream-icon-"));
  dirs.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>';

describe("findProjectIcon", () => {
  it("returns null for a project with nothing icon-shaped", () => {
    const root = project({ "README.md": "# hi", "src/index.ts": "" });
    expect(findProjectIcon(root)).toBeNull();
    expect(projectIconUrl(root)).toBeNull();
  });

  it("finds a web favicon in public/", () => {
    const root = project({ "public/favicon.ico": "ico" });
    expect(findProjectIcon(root)).toBe(join(root, "public/favicon.ico"));
  });

  it("prefers an app icon over a favicon, even one level deeper in a monorepo", () => {
    const root = project({
      "public/favicon.ico": "ico",
      "apps/desktop/icons/icon.svg": SVG,
    });
    expect(findProjectIcon(root)).toBe(join(root, "apps/desktop/icons/icon.svg"));
  });

  it("prefers a favicon over a logo, which is often a wordmark", () => {
    const root = project({ "logo.svg": SVG, "app/favicon.ico": "ico" });
    expect(findProjectIcon(root)).toBe(join(root, "app/favicon.ico"));
  });

  it("finds a Tauri icon", () => {
    const root = project({
      "src-tauri/icons/icon.png": "big",
      "src-tauri/icons/128x128@2x.png": "small",
    });
    expect(findProjectIcon(root)).toBe(join(root, "src-tauri/icons/128x128@2x.png"));
  });

  it("lets .daydream-code/icon override every guess", () => {
    const root = project({
      "icon.svg": SVG,
      ".daydream-code/icon.png": "mine",
    });
    expect(findProjectIcon(root)).toBe(join(root, ".daydream-code/icon.png"));
  });

  it("skips empty and oversized files", () => {
    const root = project({
      "icon.svg": "",
      "icon.png": Buffer.alloc(600 * 1024),
      "public/favicon.svg": SVG,
    });
    expect(findProjectIcon(root)).toBe(join(root, "public/favicon.svg"));
  });

  it("encodes the icon as a data URL with its image type", () => {
    const root = project({ "public/favicon.svg": SVG });
    const url = projectIconUrl(root);
    expect(url).toBe(`data:image/svg+xml;base64,${Buffer.from(SVG).toString("base64")}`);
  });

  it("re-reads an icon that changed on disk", () => {
    const root = project({ "icon.svg": SVG });
    const before = projectIconUrl(root);
    writeFileSync(join(root, "icon.svg"), `${SVG}<!-- edited, and longer -->`);
    expect(projectIconUrl(root)).not.toBe(before);
  });
});
