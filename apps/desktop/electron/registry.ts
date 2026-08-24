/**
 * Project-picker registry: a plain JSON file at ~/.daydream-code/registry.json
 * listing known projects. Pure helpers (explicit paths, tolerant reads) so the
 * whole module unit-tests without Electron.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface RegistryEntry {
  rootPath: string;
  name: string;
  lastOpenedAt: string;
}

export function defaultRegistryPath(): string {
  return join(homedir(), ".daydream-code", "registry.json");
}

function isEntry(value: unknown): value is RegistryEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.rootPath === "string" &&
    typeof v.name === "string" &&
    typeof v.lastOpenedAt === "string"
  );
}

/** Read the registry; missing or corrupt files read as empty. */
export function readRegistry(file: string): RegistryEntry[] {
  if (!existsSync(file)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry);
  } catch {
    return [];
  }
}

/** Write the registry, creating the parent directory as needed. */
export function writeRegistry(file: string, entries: RegistryEntry[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

/**
 * Return a new list with `rootPath` present, its lastOpenedAt bumped, sorted
 * most-recently-opened first. Never mutates the input.
 */
/**
 * Last path segment, splitting on both separators — registry files travel
 * between platforms, so a Windows rootPath must still name itself on POSIX.
 */
function lastSegment(rootPath: string): string {
  const segments = rootPath.split(/[\\/]/).filter((s) => s.length > 0);
  return segments[segments.length - 1] ?? "";
}

export function touchProject(
  entries: readonly RegistryEntry[],
  rootPath: string,
  name?: string,
  now: Date = new Date(),
): RegistryEntry[] {
  const existing = entries.find((e) => e.rootPath === rootPath);
  const entry: RegistryEntry = {
    rootPath,
    name: name ?? existing?.name ?? (lastSegment(rootPath) || rootPath),
    lastOpenedAt: now.toISOString(),
  };
  const rest = entries.filter((e) => e.rootPath !== rootPath);
  return [entry, ...rest].sort((a, b) =>
    b.lastOpenedAt.localeCompare(a.lastOpenedAt),
  );
}
