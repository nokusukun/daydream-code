import { describe, expect, it } from "vitest";
import { runPaletteAction } from "../src/palette-actions.js";

describe("runPaletteAction", () => {
  it("closes the palette before opening another overlay", () => {
    const updates: Array<string | null> = ["palette"];

    runPaletteAction(
      { run: () => updates.push("fibers") },
      () => updates.push(null),
    );

    expect(updates).toEqual(["palette", null, "fibers"]);
  });

  it("keeps palette-mode actions open", () => {
    const updates: string[] = [];

    runPaletteAction(
      { keepOpen: true, run: () => updates.push("search") },
      () => updates.push("closed"),
    );

    expect(updates).toEqual(["search"]);
  });
});
