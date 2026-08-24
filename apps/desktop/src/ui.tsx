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
 * Status as a drawn glyph rather than a coloured dot.
 *
 * A pulsing dot is the default "live" indicator everywhere, and it says
 * nothing without its colour. These are stroke glyphs at one optical weight:
 * an activity meter that actually moves while a session works, a check when it
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
        <svg {...common} className="glyph glyph-running" fill="currentColor">
          <rect x="0.5" y="1" width="2" height="8" rx="1" />
          <rect x="4" y="1" width="2" height="8" rx="1" />
          <rect x="7.5" y="1" width="2" height="8" rx="1" />
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

export function StatusPill(props: { status: string }): ReactNode {
  return <span className={`status status-${props.status}`}>{props.status}</span>;
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

export function short(value: unknown, max = 4000): string {
  const text =
    typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Single-line preview for collapsed tool rows and search hits. */
export function peek(value: unknown, max = 120): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
