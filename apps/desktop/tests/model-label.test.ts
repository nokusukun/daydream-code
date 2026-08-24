import { describe, expect, it } from "vitest";
import type { DriverCatalogEntry } from "../src/api.js";
import { labelForModel, splitModelId } from "../src/model-label.js";

const catalog: DriverCatalogEntry[] = [
  {
    driver: "claude",
    models: [
      { id: "claude-opus-5", label: "Claude Opus 5" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
    ],
  },
  {
    driver: "codex",
    models: [{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol", isDefault: true }],
  },
  { driver: "mock", models: [] },
];

describe("splitModelId", () => {
  it("splits the context-window variant out of a runtime id", () => {
    expect(splitModelId("claude-opus-5[1m]")).toEqual({
      base: "claude-opus-5",
      variant: "1m",
    });
  });

  it("leaves a plain id alone", () => {
    expect(splitModelId("gpt-5.6-sol")).toEqual({ base: "gpt-5.6-sol" });
  });

  it("only treats a trailing bracket as a variant", () => {
    expect(splitModelId("weird[name]-x")).toEqual({ base: "weird[name]-x" });
  });
});

describe("labelForModel", () => {
  it("labels a runtime id the driver reported, keeping the variant", () => {
    expect(labelForModel(catalog, "claude", "claude-opus-5[1m]")).toEqual({
      label: "Claude Opus 5",
      variant: "1m",
    });
  });

  it("labels a plain catalog id", () => {
    expect(labelForModel(catalog, "claude", "claude-haiku-4-5")).toEqual({
      label: "Claude Haiku 4.5",
    });
  });

  it("names the driver's advertised default when nothing is pinned", () => {
    expect(labelForModel(catalog, "codex", null)).toEqual({
      label: "GPT-5.6 Sol",
    });
  });

  it("says so plainly when the driver advertises no default", () => {
    expect(labelForModel(catalog, "mock", null)).toEqual({
      label: "default model",
    });
  });

  it("falls back to the base id for a model the catalog does not know", () => {
    expect(labelForModel(catalog, "claude", "claude-future-9[200k]")).toEqual({
      label: "claude-future-9",
      variant: "200k",
    });
  });
});
