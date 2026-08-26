/**
 * Applies OS appearance to the document: the System Settings accent color and
 * the light/dark theme, kept live as the user changes either.
 *
 * The theme is the one part a user can override. macOS apps that offer this
 * (Xcode, Terminal) all keep "System" as the default rather than a third state
 * you have to notice you are in, so the choice is System / Light / Dark and
 * System is what a fresh install gets. Accent and vibrancy have no override:
 * they are the OS's to decide, and there is nothing to gain by disagreeing.
 *
 * The choice is pushed back to the main process as well as written to the
 * document: the window's vibrancy material is native, and it follows the
 * window's appearance rather than anything CSS says.
 *
 * Outside Electron there is no bridge, so we leave `data-theme` unset and let
 * the `prefers-color-scheme` fallback in styles.css take over.
 */
import { useCallback, useEffect, useState } from "react";
import { bridge, type Appearance } from "./bridge.js";

export type ThemeChoice = "system" | "light" | "dark";

const STORAGE_KEY = "daydream.theme";

/** sRGB relative luminance (WCAG 2.1 definition). */
function luminance(hex: string): number {
  const value = hex.replace("#", "");
  if (value.length !== 6) return 0.5;
  const channel = (pair: string): number => {
    const c = parseInt(pair, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel(value.slice(0, 2)) +
    0.7152 * channel(value.slice(2, 4)) +
    0.0722 * channel(value.slice(4, 6))
  );
}

/**
 * Text color for sitting on the accent. macOS accents run from graphite to
 * yellow, so a hardcoded white would fail contrast on the light ones.
 */
function onAccent(hex: string): string {
  return luminance(hex) > 0.45 ? "oklch(18% 0.01 265)" : "oklch(99% 0 0)";
}

export function applyAppearance(appearance: Appearance): void {
  const root = document.documentElement;
  root.style.setProperty("--accent", appearance.accent);
  root.style.setProperty("--accent-text", onAccent(appearance.accent));
  root.dataset.theme = appearance.dark ? "dark" : "light";
  root.classList.toggle("no-vibrancy", !appearance.vibrancy);
}

function readChoice(): ThemeChoice {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
  } catch {
    // Private mode, or a renderer with storage disabled. System is the answer
    // that needs no storage.
  }
  return "system";
}

export interface ThemeState {
  /** What the user picked, which may be "system". */
  choice: ThemeChoice;
  /** What is actually on screen. */
  resolved: "light" | "dark";
  set(choice: ThemeChoice): void;
  /** Flip to the opposite of what is showing — the toolbar's one-click path. */
  toggle(): void;
}

/**
 * Subscribes to OS appearance for the lifetime of the app and returns the
 * theme control. Call once, at the root: it writes to `document`, so a second
 * caller would be a second writer racing the first.
 */
export function useAppearance(): ThemeState {
  const [choice, setChoice] = useState<ThemeChoice>(readChoice);
  const [system, setSystem] = useState<"light" | "dark">("dark");

  useEffect(() => {
    const b = bridge();
    if (b === undefined) {
      // Browser: no vibrancy behind the window, and the OS theme comes from
      // the media query rather than from the main process.
      document.documentElement.classList.add("no-vibrancy");
      const query = window.matchMedia("(prefers-color-scheme: light)");
      const read = (): void => setSystem(query.matches ? "light" : "dark");
      read();
      query.addEventListener("change", read);
      return () => query.removeEventListener("change", read);
    }
    const take = (appearance: Appearance): void => {
      applyAppearance(appearance);
      setSystem(appearance.dark ? "dark" : "light");
    };
    void b.getAppearance().then(take).catch(() => undefined);
    return b.onAppearance(take);
  }, []);

  const resolved = choice === "system" ? system : choice;

  // Written after `applyAppearance` rather than instead of it: the accent and
  // vibrancy classes still come from the OS, and only the theme is overridden.
  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);

  // The document is only half the window. The vibrancy material behind it is
  // drawn by the window server from the window's native appearance, so a theme
  // the renderer keeps to itself leaves a light material under dark CSS —
  // invisible while every surface was opaque, and the whole page once they are
  // not. `choice`, not `resolved`: "system" has to stay a live subscription
  // rather than being frozen to whatever the OS happened to be at the time.
  useEffect(() => {
    void bridge()?.setThemeSource?.(choice);
  }, [choice]);

  const set = useCallback((next: ThemeChoice) => {
    setChoice(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // The preference is lost on reload; the app still works.
    }
  }, []);

  const toggle = useCallback(
    () => set(resolved === "dark" ? "light" : "dark"),
    [set, resolved],
  );

  return { choice, resolved, set, toggle };
}
