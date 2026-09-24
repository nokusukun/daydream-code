/**
 * Window-level layout survives project workspace remounts. Project content
 * (selected threads, open files, drafts) stays in the project-scoped harness;
 * only the arrangement the user made around that content belongs here.
 */

export interface WindowLayout {
  mode: string;
  splitMode: string | null;
  /**
   * The global flag from before choices were per-mode. Kept as the last
   * resolution fallback rather than migrated, so a user who hid the rail
   * under the old scheme still finds it hidden — without inventing per-mode
   * choices they never made.
   */
  sidebar: boolean;
  /** Explicit per-mode sidebar choices. Absence means "never toggled here". */
  sidebarModes: Readonly<Record<string, boolean>>;
}

export interface LayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = "ddc.window-layout.v1";
const DEFAULT_LAYOUT: WindowLayout = {
  mode: "agent",
  splitMode: null,
  sidebar: true,
  sidebarModes: {},
};

/**
 * Effective sidebar visibility for a mode: the user's explicit choice for
 * that mode, else the mode's own declared default, else the legacy global
 * flag. Both the ⌘B handler and the palette label resolve through this one
 * function so the promise and the behavior cannot drift apart.
 */
export function sidebarVisible(
  layout: Pick<WindowLayout, "sidebar" | "sidebarModes">,
  modeId: string,
  modeDefault?: boolean,
): boolean {
  return layout.sidebarModes[modeId] ?? modeDefault ?? layout.sidebar;
}

function browserStorage(): LayoutStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/** Keep only boolean-valued entries; anything else is stale-format noise. */
function booleanRecord(value: unknown): Record<string, boolean> {
  const source = record(value);
  if (source === null) return {};
  const out: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (typeof entry === "boolean") out[key] = entry;
  }
  return out;
}

/** Read defensively: a stale module id is validated once modules load. */
export function loadWindowLayout(
  storage: LayoutStorage | null = browserStorage(),
): WindowLayout {
  if (storage === null) return { ...DEFAULT_LAYOUT };
  try {
    const raw = storage.getItem(STORAGE_KEY);
    const value = raw === null ? null : record(JSON.parse(raw) as unknown);
    return {
      mode:
        typeof value?.mode === "string" && value.mode.length > 0
          ? value.mode
          : DEFAULT_LAYOUT.mode,
      splitMode:
        value?.splitMode === null || typeof value?.splitMode === "string"
          ? value.splitMode
          : DEFAULT_LAYOUT.splitMode,
      sidebar:
        typeof value?.sidebar === "boolean"
          ? value.sidebar
          : DEFAULT_LAYOUT.sidebar,
      sidebarModes: booleanRecord(value?.sidebarModes),
    };
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

/** Merge writes so independently mounted panel controls cannot erase peers. */
export function saveWindowLayout(
  update: Partial<WindowLayout>,
  storage: LayoutStorage | null = browserStorage(),
): void {
  if (storage === null) return;
  try {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...loadWindowLayout(storage), ...update }),
    );
  } catch {
    // Private or full storage must not make the workspace controls unusable.
  }
}
