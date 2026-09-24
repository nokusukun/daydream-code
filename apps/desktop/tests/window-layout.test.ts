import { describe, expect, it } from "vitest";
import {
  loadWindowLayout,
  saveWindowLayout,
  sidebarVisible,
  type LayoutStorage,
} from "../src/window-layout.js";

class FakeStorage implements LayoutStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("window layout", () => {
  it("round-trips the active and split views with the sidebar", () => {
    const storage = new FakeStorage();
    saveWindowLayout(
      { mode: "code", splitMode: "terminal", sidebar: false },
      storage,
    );
    expect(loadWindowLayout(storage)).toEqual({
      mode: "code",
      splitMode: "terminal",
      sidebar: false,
      sidebarModes: {},
    });
  });

  it("merges writes from independently mounted controls", () => {
    const storage = new FakeStorage();
    saveWindowLayout({ mode: "terminal" }, storage);
    saveWindowLayout({ splitMode: "code" }, storage);
    saveWindowLayout({ sidebar: false }, storage);
    expect(loadWindowLayout(storage)).toEqual({
      mode: "terminal",
      splitMode: "code",
      sidebar: false,
      sidebarModes: {},
    });
  });

  it("recovers field by field from stale or malformed data", () => {
    const storage = new FakeStorage();
    storage.setItem(
      "ddc.window-layout.v1",
      JSON.stringify({ mode: "", splitMode: 7, sidebar: false }),
    );
    expect(loadWindowLayout(storage)).toEqual({
      mode: "agent",
      splitMode: null,
      sidebar: false,
      sidebarModes: {},
    });
    storage.setItem("ddc.window-layout.v1", "{bad json");
    expect(loadWindowLayout(storage)).toEqual({
      mode: "agent",
      splitMode: null,
      sidebar: true,
      sidebarModes: {},
    });
  });

  it("round-trips per-mode sidebar choices and drops non-boolean entries", () => {
    const storage = new FakeStorage();
    saveWindowLayout({ sidebarModes: { board: true, agent: false } }, storage);
    expect(loadWindowLayout(storage).sidebarModes).toEqual({
      board: true,
      agent: false,
    });
    storage.setItem(
      "ddc.window-layout.v1",
      JSON.stringify({ sidebarModes: { board: "yes", code: false, agent: 1 } }),
    );
    expect(loadWindowLayout(storage).sidebarModes).toEqual({ code: false });
  });

  it("continues without storage", () => {
    expect(loadWindowLayout(null)).toEqual({
      mode: "agent",
      splitMode: null,
      sidebar: true,
      sidebarModes: {},
    });
    expect(() => saveWindowLayout({ mode: "code" }, null)).not.toThrow();
  });
});

describe("sidebarVisible", () => {
  it("prefers the explicit per-mode choice over everything", () => {
    const layout = { sidebar: true, sidebarModes: { board: true } };
    expect(sidebarVisible(layout, "board", false)).toBe(true);
    expect(sidebarVisible({ ...layout, sidebar: false }, "board", false)).toBe(
      true,
    );
  });

  it("falls back to the mode's declared default before the legacy flag", () => {
    // The board's case: no choice recorded, default hidden — the legacy
    // global flag (true for anyone who ever toggled anywhere) must not win.
    expect(
      sidebarVisible({ sidebar: true, sidebarModes: {} }, "board", false),
    ).toBe(false);
  });

  it("honors the legacy global flag for modes with no declared default", () => {
    // A user who hid the rail under the pre-per-mode scheme keeps it hidden.
    expect(
      sidebarVisible({ sidebar: false, sidebarModes: {} }, "agent", undefined),
    ).toBe(false);
    expect(
      sidebarVisible({ sidebar: true, sidebarModes: {} }, "agent", undefined),
    ).toBe(true);
  });
});
