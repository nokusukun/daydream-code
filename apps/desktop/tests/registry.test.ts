import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readRegistry,
  touchProject,
  writeRegistry,
  type RegistryEntry,
} from "../electron/registry.js";

const dirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "daydream-registry-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("registry", () => {
  it("reads a missing file as empty", () => {
    expect(readRegistry(join(tmp(), "nope", "registry.json"))).toEqual([]);
  });

  it("reads corrupt or wrong-shaped files as empty", () => {
    const dir = tmp();
    const corrupt = join(dir, "corrupt.json");
    writeFileSync(corrupt, "{not json", "utf8");
    expect(readRegistry(corrupt)).toEqual([]);

    const wrongShape = join(dir, "wrong.json");
    writeFileSync(wrongShape, JSON.stringify({ hello: 1 }), "utf8");
    expect(readRegistry(wrongShape)).toEqual([]);
  });

  it("drops malformed entries but keeps valid ones", () => {
    const dir = tmp();
    const file = join(dir, "registry.json");
    const good: RegistryEntry = {
      rootPath: "C:\\proj\\a",
      name: "a",
      lastOpenedAt: "2026-08-23T00:00:00.000Z",
    };
    writeFileSync(file, JSON.stringify([good, { rootPath: 42 }, "junk"]), "utf8");
    expect(readRegistry(file)).toEqual([good]);
  });

  it("round-trips write → read, creating parent directories", () => {
    const file = join(tmp(), "nested", "deeper", "registry.json");
    const entries: RegistryEntry[] = [
      { rootPath: "/p/one", name: "one", lastOpenedAt: "2026-08-01T00:00:00.000Z" },
      { rootPath: "/p/two", name: "two", lastOpenedAt: "2026-08-02T00:00:00.000Z" },
    ];
    writeRegistry(file, entries);
    expect(readRegistry(file)).toEqual(entries);
  });

  it("touchProject inserts new projects at the top with a derived name", () => {
    const now = new Date("2026-08-23T12:00:00.000Z");
    const next = touchProject([], "C:\\Users\\x\\projects\\demo", undefined, now);
    expect(next).toEqual([
      {
        rootPath: "C:\\Users\\x\\projects\\demo",
        name: "demo",
        lastOpenedAt: now.toISOString(),
      },
    ]);
  });

  it("touchProject bumps existing entries, keeps names, sorts newest first", () => {
    const existing: RegistryEntry[] = [
      { rootPath: "/p/a", name: "custom-a", lastOpenedAt: "2026-08-01T00:00:00.000Z" },
      { rootPath: "/p/b", name: "b", lastOpenedAt: "2026-08-10T00:00:00.000Z" },
    ];
    const now = new Date("2026-08-23T12:00:00.000Z");
    const next = touchProject(existing, "/p/a", undefined, now);
    expect(next.map((e) => e.rootPath)).toEqual(["/p/a", "/p/b"]);
    expect(next[0]).toMatchObject({ name: "custom-a", lastOpenedAt: now.toISOString() });
    // input untouched
    expect(existing[0]?.lastOpenedAt).toBe("2026-08-01T00:00:00.000Z");
  });
});
