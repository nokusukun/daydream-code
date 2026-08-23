/** Small shared presentational helpers. */
import type { ReactNode } from "react";
import type { ModelMessage } from "@daydream-code/shared";

export function Badge(props: { kind: string }): ReactNode {
  return <span className={`badge badge-${props.kind}`}>{props.kind.replace(/^session_/, "")}</span>;
}

export function StatusPill(props: { status: string }): ReactNode {
  return <span className={`status status-${props.status}`}>{props.status}</span>;
}

export function fmtTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString(undefined, { hour12: false });
}

export function fmtDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString(undefined, { hour12: false })}`;
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

export function SessionLink(props: {
  id: string;
  onOpen(id: string): void;
  children?: ReactNode;
}): ReactNode {
  return (
    <button
      type="button"
      className="session-link"
      title={props.id}
      onClick={() => props.onOpen(props.id)}
    >
      {props.children ?? props.id}
    </button>
  );
}
