/**
 * A project's mark: its own icon when the main process found one on disk
 * (`electron/project-icon.ts`), otherwise a generated tile of its initials.
 *
 * The generated tile is coloured per project, not in the accent. Every project
 * shares the accent, so an accent tile says "a project" where the mark exists
 * to say "which project" — a list of four blue W-and-S circles is four rows
 * you still have to read.
 */
import { useState, type CSSProperties, type ReactNode } from "react";

/**
 * Hues for generated marks, in oklch degrees: red, orange, amber, green, teal,
 * blue, purple, pink. Eight, not more: at a 22px tile two hues closer than
 * about 45° read as one colour, and the point is that neighbours do not.
 */
export const MARK_HUES = [22, 52, 82, 150, 195, 245, 295, 345] as const;

/** FNV-1a. Stable across runs and machines, which a colour must be. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Keyed on the folder, not the name: two checkouts called `api` are exactly
 * the pair the colour has to tell apart.
 */
export function markHue(seed: string): number {
  return MARK_HUES[hash(seed) % MARK_HUES.length] ?? MARK_HUES[0];
}

/**
 * One or two letters. Two when the name has two words (`services-api` → SA,
 * `daydreamCode` → DC), because a lone S does not separate it from `scratch`;
 * one when it does not, rather than the first two letters of a single word,
 * which spell nothing.
 */
export function markInitials(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s\-_.@/]+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word));
  const first = (word: string | undefined): string => {
    if (word === undefined) return "";
    const ch = Array.from(word).find((c) => /[\p{L}\p{N}]/u.test(c));
    return ch === undefined ? "" : ch.toLocaleUpperCase();
  };
  const initials = first(words[0]) + first(words[1]);
  return initials.length > 0 ? initials : "?";
}

export function ProjectMark(props: {
  name: string;
  rootPath: string;
  icon?: string | null | undefined;
  /** CSS pixels. The row uses a larger mark than the toolbar trigger. */
  size?: number;
}): ReactNode {
  const size = props.size ?? 22;
  // A data URL the image decoder rejects (a corrupt favicon) falls back to
  // the generated tile instead of leaving a broken-image hole. Keyed on the
  // URL so a fixed icon gets its chance on the next list.
  const [failed, setFailed] = useState<string | null>(null);
  const icon = props.icon ?? null;

  if (icon !== null && failed !== icon) {
    return (
      <span
        className="proj-mark proj-mark-image"
        style={{ "--mark-size": `${size}px` } as CSSProperties}
        aria-hidden="true"
      >
        <img src={icon} alt="" draggable={false} onError={() => setFailed(icon)} />
      </span>
    );
  }

  const initials = markInitials(props.name);
  return (
    <span
      className={"proj-mark proj-mark-glyph" + (initials.length > 1 ? " proj-mark-pair" : "")}
      style={
        {
          "--mark-size": `${size}px`,
          "--mark-h": markHue(props.rootPath),
        } as CSSProperties
      }
      aria-hidden="true"
    >
      {initials}
    </span>
  );
}
