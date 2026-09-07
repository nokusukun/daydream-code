import { describe, expect, it } from "vitest";
import {
  loadWindowLayout,
  saveWindowLayout,
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
    });
    storage.setItem("ddc.window-layout.v1", "{bad json");
    expect(loadWindowLayout(storage)).toEqual({
      mode: "agent",
      splitMode: null,
      sidebar: true,
    });
  });

  it("continues without storage", () => {
    expect(loadWindowLayout(null)).toEqual({
      mode: "agent",
      splitMode: null,
      sidebar: true,
    });
    expect(() => saveWindowLayout({ mode: "code" }, null)).not.toThrow();
  });
});
