import { beforeEach, describe, expect, it } from "vitest";
import {
  driverSupportsFastMode,
  fastModeAvailable,
  loadChoice,
  modelEfforts,
} from "../src/model-selector.js";
import type { DriverCatalogEntry } from "../src/api.js";

/**
 * Storage is a trust boundary: a choice saved by an older build has no
 * `effort` key, and rejecting it would silently reset the user's model on
 * upgrade — the same class of bug as the archivedAt `undefined !== null`
 * misread. These pin the degrade-to-default paths.
 */

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
});

describe("loadChoice", () => {
  it("fills effort with null for a choice saved before effort existed", () => {
    store.set(
      "daydream.model-choice",
      JSON.stringify({ driver: "codex", modelId: "gpt-5.6-sol" }),
    );
    expect(loadChoice()).toEqual({
      driver: "codex",
      modelId: "gpt-5.6-sol",
      effort: null,
      fastMode: false,
    });
  });

  it("round-trips a stored effort", () => {
    store.set(
      "daydream.model-choice",
      JSON.stringify({ driver: "claude", modelId: "claude-opus-5", effort: "xhigh" }),
    );
    expect(loadChoice().effort).toBe("xhigh");
  });

  it("round-trips fast mode and defaults older choices to standard speed", () => {
    store.set(
      "daydream.model-choice",
      JSON.stringify({
        driver: "codex",
        modelId: "gpt-5.6-sol",
        fastMode: true,
      }),
    );
    expect(loadChoice().fastMode).toBe(true);

    store.set(
      "daydream.model-choice",
      JSON.stringify({ driver: "codex", modelId: "gpt-5.6-sol" }),
    );
    expect(loadChoice().fastMode).toBe(false);
  });

  it("degrades a non-string effort to null rather than rejecting the choice", () => {
    store.set(
      "daydream.model-choice",
      JSON.stringify({ driver: "claude", modelId: "claude-opus-5", effort: 3 }),
    );
    expect(loadChoice()).toEqual({
      driver: "claude",
      modelId: "claude-opus-5",
      effort: null,
      fastMode: false,
    });
  });

  it("falls back to the default choice for garbage", () => {
    store.set("daydream.model-choice", "not json");
    expect(loadChoice()).toEqual({
      driver: "claude",
      modelId: null,
      effort: null,
      fastMode: false,
    });
  });

  it("still loads a usable default when browser storage is unavailable", () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => {
        throw new Error("storage blocked");
      },
      setItem: () => {
        throw new Error("storage blocked");
      },
    };
    expect(loadChoice()).toEqual({
      driver: "claude",
      modelId: null,
      effort: null,
      fastMode: false,
    });
  });
});

describe("modelEfforts", () => {
  const catalog: DriverCatalogEntry[] = [
    {
      driver: "claude",
      supportsFastMode: true,
      models: [
        { id: "m-full", label: "Full", efforts: ["low", "high"] },
        { id: "m-none", label: "None" },
      ],
    },
  ];

  it("returns the catalog's levels for a pinned model", () => {
    expect(modelEfforts(catalog, "claude", "m-full")).toEqual(["low", "high"]);
  });

  it("returns none for a model that lists none", () => {
    expect(modelEfforts(catalog, "claude", "m-none")).toEqual([]);
  });

  it("returns none for the default row — no model, no known levels", () => {
    expect(modelEfforts(catalog, "claude", null)).toEqual([]);
  });

  it("returns none for a model or driver the catalog does not know", () => {
    expect(modelEfforts(catalog, "claude", "gone")).toEqual([]);
    expect(modelEfforts(catalog, "codex", "m-full")).toEqual([]);
  });
});

describe("driverSupportsFastMode", () => {
  const catalog: DriverCatalogEntry[] = [
    { driver: "claude", models: [], supportsFastMode: true },
    { driver: "mock", models: [], supportsFastMode: false },
  ];

  it("uses the driver's advertised capability, including its default model", () => {
    expect(driverSupportsFastMode(catalog, "claude")).toBe(true);
    expect(driverSupportsFastMode(catalog, "mock")).toBe(false);
    expect(driverSupportsFastMode(catalog, "missing")).toBe(false);
  });

  it("waits for the live catalog before exposing an actionable Fast control", () => {
    expect(fastModeAvailable(false, catalog, "claude")).toBe(false);
    expect(fastModeAvailable(true, catalog, "claude")).toBe(true);
    expect(fastModeAvailable(true, catalog, "mock")).toBe(false);
  });
});
