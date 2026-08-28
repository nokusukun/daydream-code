/**
 * Terminal theming, in the one place it has to be done by hand.
 *
 * Every colour in this app is a custom property built from `color-mix()`,
 * `oklch()` and `light-dark()`. xterm parses its theme colours itself and reads
 * none of those — and a canvas cannot resolve `light-dark()` either, because
 * that function needs an element's `color-scheme` to pick a side. So the values
 * are resolved the only way that is guaranteed correct: assign them to a real
 * element's `color`, let the engine compute them in context, then normalise the
 * result to sRGB hex through a 1x1 canvas.
 *
 * The alternative — hardcoding a terminal palette — would make this the one
 * surface in the app that ignores the OS accent and does not follow the theme.
 */
import type { ITheme } from "@xterm/xterm";

/** The 16 ANSI slots, in the order xterm names them. */
const ANSI_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

export interface ColorResolver {
  resolve(expression: string): string | null;
  /**
   * The colour actually painted behind `host`: the nearest ancestor with a
   * non-transparent background. Resolving the pane's real fill, rather than
   * the token we believe it uses, keeps the emulator seamless with the pane
   * even when an accessibility override swaps the pane's background.
   */
  resolveSurface(): string | null;
  dispose(): void;
}

/**
 * A resolver bound to `host`, so `light-dark()` and inherited custom properties
 * are computed in the same context the terminal is rendered in.
 */
/**
 * Two colours no palette would land on, used to tell "resolved" from
 * "inherited" — see `resolve`.
 */
const SENTINEL_A = "rgb(1, 2, 3)";
const SENTINEL_B = "rgb(4, 5, 6)";

export function createColorResolver(host: HTMLElement): ColorResolver {
  // The probe sits inside a wrapper whose own colour we control, because the
  // only way to detect an unresolvable token is to see whether the probe
  // follows its parent.
  const wrapper = document.createElement("div");
  wrapper.style.display = "none";
  const probe = document.createElement("span");
  wrapper.appendChild(probe);
  host.appendChild(wrapper);
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });

  const read = (expression: string, inherited: string): string => {
    wrapper.style.color = inherited;
    probe.style.color = "";
    probe.style.color = expression;
    return window.getComputedStyle(probe).color;
  };

  return {
    resolve(expression: string): string | null {
      /*
       * A token the engine cannot resolve does not throw and does not clear
       * `color` — it leaves the property inherited. Measured in Electron 38:
       * `var(--nope)` on a span inside `color: rgb(9,9,9)` computes to exactly
       * `rgb(9, 9, 9)`. So an unparseable expression is indistinguishable from
       * a valid one by its value alone, and a missing `--ansi-*` scale would
       * silently theme all sixteen slots with the surrounding text colour.
       *
       * Reading it twice against different inherited colours settles it: a
       * value that tracks its parent is not a value the expression produced.
       */
      const first = read(expression, SENTINEL_A);
      if (first === SENTINEL_A) {
        const second = read(expression, SENTINEL_B);
        if (second === SENTINEL_B) return null;
      }
      const computed = first;
      if (computed.length === 0) return null;
      if (context === null) return computed;
      // Computed `color` can still be `oklch(...)` or `color(display-p3 ...)`.
      // The canvas has no `light-dark()` left to resolve by this point, so it
      // is a safe last step, and getImageData is unambiguously sRGB.
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = "#000000";
      context.fillStyle = computed;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
      return `#${hex(r)}${hex(g)}${hex(b)}`;
    },
    resolveSurface(): string | null {
      let at: HTMLElement | null = host;
      while (at !== null) {
        const painted = window.getComputedStyle(at).backgroundColor;
        if (painted.length > 0 && painted !== "transparent" && !isFullyTransparent(painted)) {
          return this.resolve(painted);
        }
        at = at.parentElement;
      }
      return null;
    },
    dispose(): void {
      wrapper.remove();
    },
  };
}

function isFullyTransparent(color: string): boolean {
  const match = /rgba?\([^)]*[,/]\s*(0|0?\.0+)\s*\)$/.exec(color);
  return match !== null;
}

function hex(value: number | undefined): string {
  return (value ?? 0).toString(16).padStart(2, "0");
}

/**
 * Build xterm's theme from the app's tokens.
 *
 * Each entry falls back to a literal only if the token cannot be resolved at
 * all, which happens in a plain browser with no stylesheet applied yet.
 */
export function readTerminalTheme(resolver: ColorResolver, dark: boolean): ITheme {
  const pick = (expression: string, fallback: string): string =>
    resolver.resolve(expression) ?? fallback;

  const foreground = pick("var(--text-1)", dark ? "#e8e8ea" : "#1c1c1e");
  // The pane's real fill first: the emulator must be seamless with the glass
  // pane it sits in, whichever token — or accessibility override — painted it.
  const background =
    resolver.resolveSurface() ??
    pick("var(--panel-surface)", dark ? "#1c1d21" : "#fbfbfd");
  const accent = pick("var(--accent-ink)", dark ? "#7aa2f7" : "#2f6feb");

  const theme: ITheme = {
    foreground,
    background,
    cursor: accent,
    cursorAccent: background,
    // A selection the terminal draws must read against arbitrary output, so it
    // is a translucent accent veil rather than a solid fill.
    selectionBackground: pick(
      "color-mix(in oklab, var(--accent) 32%, transparent)",
      "rgba(120, 160, 255, 0.32)",
    ),
    selectionInactiveBackground: pick(
      "color-mix(in oklab, var(--accent) 16%, transparent)",
      "rgba(120, 160, 255, 0.16)",
    ),
  };

  ANSI_KEYS.forEach((key, index) => {
    const resolved = resolver.resolve(`var(--ansi-${String(index)})`);
    if (resolved !== null) theme[key] = resolved;
  });
  return theme;
}

/**
 * Which side the theme is on, for the fallbacks only.
 *
 * The bridge sets `data-theme`, but a renderer running in a plain browser never
 * gets one — and `styles.css` answers that case with a `prefers-color-scheme`
 * block, so treating "absent" as dark would disagree with the stylesheet on a
 * light desktop.
 */
export function isDarkTheme(): boolean {
  const attribute = document.documentElement.dataset.theme;
  if (attribute === "dark") return true;
  if (attribute === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/**
 * Watch for anything that changes what those tokens resolve to.
 *
 * `data-theme` covers light/dark, and inline `style` covers the OS accent,
 * which main pushes onto the root element whenever the user changes it in
 * System Settings. Both land on `documentElement`.
 */
export function watchThemeTokens(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "style", "class"],
  });
  return () => observer.disconnect();
}

/** Terminal ids are `term-N`; the next one fills the lowest free slot. */
export function nextTerminalId(existing: readonly string[]): string {
  const taken = new Set(existing);
  for (let n = 1; ; n += 1) {
    const id = `term-${String(n)}`;
    if (!taken.has(id)) return id;
  }
}

/** `term-3` reads as "3" on a tab; anything else is shown as it came. */
export function terminalLabel(terminalId: string): string {
  const match = /^term-(\d+)$/.exec(terminalId);
  return match === null ? terminalId : `Terminal ${match[1]!}`;
}
