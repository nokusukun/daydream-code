import { beforeEach, describe, expect, it } from "vitest";
import { loadChoice, modelEfforts } from "../src/model-selector.js";
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
    });
  });

  it("round-trips a stored effort", () => {
    store.set(
      "daydream.model-choice",
      JSON.stringify({ driver: "claude", modelId: "claude-opus-5", effort: "xhigh" }),
    );
    expect(loadChoice().effort).toBe("xhigh");
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
    });
  });

  it("falls back to the default choice for garbage", () => {
    store.set("daydream.model-choice", "not json");
    expect(loadChoice()).toEqual({ driver: "claude", modelId: null, effort: null });
  });
});

describe("modelEfforts", () => {
  const catalog: DriverCatalogEntry[] = [
    {
      driver: "claude",
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
