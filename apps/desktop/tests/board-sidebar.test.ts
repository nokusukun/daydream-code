/**
 * The board hides the thread rail by default, as a per-mode choice the user
 * can toggle back on. The default is declared on the board's own mode
 * contribution and resolved by `sidebarVisible`, so these tests pin both ends
 * of that contract rather than one side of it.
 */
import { describe, expect, it } from "vitest";
import board from "../src/modules/features/board.js";
import type {
  DesktopModuleContext,
  ModeContribution,
} from "../src/modules/runtime.js";
import { loadWindowLayout, sidebarVisible } from "../src/window-layout.js";

function activateBoard(): ModeContribution {
  let contribution: ModeContribution | undefined;
  const context: DesktopModuleContext = {
    moduleId: "board",
    effect: () => () => {},
    registerMode: (entry) => {
      contribution = entry;
      return () => {};
    },
    registerOverlay: () => () => {},
    registerToolbar: () => () => {},
  };
  board.activate(context);
  if (contribution === undefined) throw new Error("board registered no mode");
  return contribution;
}

describe("board sidebar default", () => {
  it("declares the rail hidden for users who never toggled it", () => {
    const mode = activateBoard();
    expect(mode.sidebarDefault).toBe(false);
    // The rail itself is still contributed — hidden is a default, not a
    // removal, or ⌘B would have nothing to bring back.
    expect(mode.sidebar).toBeDefined();
  });

  it("resolves hidden on a fresh layout, and an explicit toggle wins", () => {
    const mode = activateBoard();
    const fresh = loadWindowLayout(null);
    expect(sidebarVisible(fresh, mode.id, mode.sidebarDefault)).toBe(false);
    // The user pressed ⌘B on the board: their choice beats the default and
    // survives independently of the other modes' rails.
    const chosen = { ...fresh, sidebarModes: { [mode.id]: true } };
    expect(sidebarVisible(chosen, mode.id, mode.sidebarDefault)).toBe(true);
    expect(sidebarVisible(chosen, "agent", undefined)).toBe(true);
  });
});
