/** Small shared presentational helpers. */
import type { ReactNode } from "react";
import type { ModelMessage } from "@daydream-code/shared";

/**
 * A gear, drawn as a ring with eight radial teeth at the same optical weight as
 * the status glyphs. Eight *outlined* teeth turn to mud at 16px; a ring plus
 * strokes stays legible and matches how every other icon here is built.
 */
export function GearIcon(): ReactNode {
  return (
    <svg
      viewBox="0 0 16 16"
      width={15}
      height={15}
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
    >
      <circle cx="8" cy="8" r="3.2" />
      <path d="M11.4 8H14M10.4 5.6l1.84-1.84M8 4.6V2M5.6 5.6 3.76 3.76M4.6 8H2M5.6 10.4l-1.84 1.84M8 11.4V14M10.4 10.4l1.84 1.84" />
    </svg>
  );
}

/**
 * Quick actions. A bolt at the same optical weight as the gear beside it —
 * the two toolbar popovers should read as one family, not as two icon sets.
 */
export function BoltIcon(): ReactNode {
  return (
    <svg
      viewBox="0 0 16 16"
      width={15}
      height={15}
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8.9 1.8 3.4 9.1h3.9l-.9 5.1 5.5-7.3H8z" />
    </svg>
  );
}

/**
 * The send action, drawn as its own shortcut: ⌘⏎. The button and the hint
 * used to be two separate things saying one thing — a mark you press, and a
 * kbd row telling you the keys that press it. Folding the keys into the mark
 * makes the button self-describing, so the footer no longer needs a bare
 * "⌘ return" hint beside it. Same stroke weight as the gear and the bolt so
 * the chrome icons stay one family.
 */
export function SendIcon(): ReactNode {
  return (
    <svg
      viewBox="0 0 27 16"
      width={25}
      height={15}
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* ⌘ — the lucide command path, scaled into the left half. The inner
          strokeWidth is 1.6 ÷ 0.55 so the effective weight matches siblings. */}
      <g transform="translate(-0.65 1.4) scale(0.55)">
        <path
          strokeWidth="2.9"
          d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"
        />
      </g>
      {/* ⏎ — down from the top right, then left, arrowhead at the exit. */}
      <path d="M26 3.6v3.6a2.4 2.4 0 0 1-2.4 2.4H15.6" />
      <path d="M18.4 6.8 15.6 9.6l2.8 2.8" />
    </svg>
  );
}

/**
 * The shift key, for the send split's defer segment. The main segment already
 * says ⌘⏎; this one adds the ⇧ that turns the chord into "send when this
 * thread ends", so the pair reads as one shortcut family rather than two
 * unrelated marks.
 */
export function ShiftIcon(): ReactNode {
  return (
    <svg
      viewBox="0 0 16 16"
      width={15}
      height={15}
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 3.4 12.6 8.6h-2.4v4H5.8v-4H3.4z" />
    </svg>
  );
}

/**
 * The stop action: a filled rounded square, the universal transport glyph.
 * Filled rather than stroked on purpose — it sits on a danger button next to
 * the send mark, and a hollow square at this size reads as a checkbox.
 */
export function StopIcon(): ReactNode {
  return (
    <svg
      viewBox="0 0 16 16"
      width={15}
      height={15}
      aria-hidden="true"
      focusable="false"
      fill="currentColor"
      stroke="none"
    >
      <rect x="4" y="4" width="8" height="8" rx="1.8" />
    </svg>
  );
}

/**
 * Status as a drawn glyph rather than a coloured dot.
 *
 * A pulsing dot is the default "live" indicator everywhere, and it says
 * nothing without its colour. These are stroke glyphs at one optical weight:
 * a native activity ring that moves while a session works, a check when it
 * lands, a cross when it fails, a square when it was stopped. Shape carries
 * the meaning; colour only reinforces it.
 */
export function StatusGlyph(props: { status: string }): ReactNode {
  const common = {
    viewBox: "0 0 10 10",
    width: 10,
    height: 10,
    "aria-hidden": true as const,
    focusable: "false" as const,
  };

  switch (props.status) {
    case "running":
      return (
        <svg
          {...common}
          className="glyph glyph-running"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.45"
          strokeLinecap="round"
        >
          <circle className="glyph-running-track" cx="5" cy="5" r="3.7" />
          <circle
            className="glyph-running-light"
            cx="5"
            cy="5"
            r="3.7"
            pathLength="100"
            strokeDasharray="68 32"
          />
        </svg>
      );
    case "completed":
      return (
        <svg
          {...common}
          className="glyph glyph-completed"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M1.5 5.4 4 7.8 8.6 2.4" />
        </svg>
      );
    case "failed":
      return (
        <svg
          {...common}
          className="glyph glyph-failed"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        >
          <path d="M2.2 2.2 7.8 7.8M7.8 2.2 2.2 7.8" />
        </svg>
      );
    case "killed":
      return (
        <svg {...common} className="glyph glyph-killed" fill="currentColor">
          <rect x="1.8" y="1.8" width="6.4" height="6.4" rx="1.4" />
        </svg>
      );
    // Blocked on a human. A distinct shape, not just a colour: status is never
    // encoded in colour alone here, and this is the one status that is asking
    // the user for something rather than reporting on itself.
    case "waiting":
      return (
        <svg
          {...common}
          className="glyph glyph-waiting"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        >
          <circle cx="5" cy="5" r="3.9" />
          <path d="M5 3.1v2.2l1.5 1.1" />
        </svg>
      );
    default:
      return (
        <svg
          {...common}
          className="glyph glyph-other"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
        >
          <circle cx="5" cy="5" r="3.4" />
        </svg>
      );
  }
}

/**
 * 56.6k. A rail row has space for a number, not for six digits.
 *
 * Here rather than in a view because the rail, the session strip, the usage
 * table and the code viewer all print the same counts, and two copies of the
 * rounding rule meant the rail and the strip could disagree about one number.
 */
export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}m`;
}

export function fmtTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function fmtDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })} ${fmtTime(iso)}`;
}

/** "just now" / "4m" / "2h" / "3d" — the sidebar has no room for timestamps. */
export function fmtAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 45) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Flatten a durable ModelMessage's content to display text. */
export function messageText(message: ModelMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => {
      switch (part.type) {
        case "text":
        case "marker":
          return part.text;
        case "image":
          return `🖼 ${part.alt ?? part.mediaType}`;
        case "tool_call":
          return `→ ${part.toolName}(${JSON.stringify(part.args ?? null)})`;
        case "tool_result":
          return `← ${part.toolName}: ${JSON.stringify(part.result ?? null)}`;
        default:
          return JSON.stringify(part);
      }
    })
    .join("\n");
}

/**
 * The full text of a payload value, uncapped. For rows that clamp in the view
 * (a "read more" the reader can open) rather than cutting the data — a `short`
 * of a long reply drops its tail silently, mid-word, and right-click copy then
 * copies the cut rather than the message.
 */
export function fullText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2);
}

export function short(value: unknown, max = 4000): string {
  const text = fullText(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Single-line preview for collapsed tool rows and search hits. */
export function peek(value: unknown, max = 120): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
