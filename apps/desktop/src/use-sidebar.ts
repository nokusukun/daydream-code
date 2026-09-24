/**
 * Effective sidebar visibility for the active mode, and the toggle that flips
 * it. Lives beside neither the harness nor the module runtime because it needs
 * both: the harness holds the persisted choices, the mode contributions hold
 * each mode's declared default (`sidebarDefault` — the board opts out of the
 * rail, agent and code keep it). Toggling records an explicit per-mode choice,
 * so hiding the rail on the board does not hide it in agent mode and vice
 * versa.
 */
import { useCallback } from "react";
import { useHarness } from "./harness.js";
import { useDesktopModules } from "./modules/react.js";
import { sidebarVisible } from "./window-layout.js";

export function useSidebar(): { sidebar: boolean; toggleSidebar(): void } {
  const { mode, sidebarLayout, setSidebar } = useHarness();
  const { modes } = useDesktopModules();
  const entry = modes.find((candidate) => candidate.id === mode);
  const sidebar = sidebarVisible(sidebarLayout, mode, entry?.sidebarDefault);
  const toggleSidebar = useCallback(
    () => setSidebar(mode, !sidebar),
    [setSidebar, mode, sidebar],
  );
  return { sidebar, toggleSidebar };
}
