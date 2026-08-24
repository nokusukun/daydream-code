import type { CodeContextMenuRequest } from "./bridge.js";

/** The path label attached to a selected range. */
export function selectionReference(
  path: string,
  lineStart?: number,
  lineEnd?: number,
): string {
  if (lineStart === undefined) return path;
  if (lineEnd === undefined || lineEnd === lineStart) return `${path}:L${lineStart}`;
  return `${path}:L${Math.min(lineStart, lineEnd)}-L${Math.max(lineStart, lineEnd)}`;
}

/** A useful, editable dispatch draft rather than an immediately-started task. */
export function selectionDraft(
  request: Extract<CodeContextMenuRequest, { kind: "selection" }>,
  language: string,
): string {
  const reference = selectionReference(
    request.path,
    request.lineStart,
    request.lineEnd,
  );
  const fence = request.text.includes("```") ? "````" : "```";
  return `Help me with this code from \`${reference}\`:\n\n${fence}${language === "text" ? "" : language}\n${request.text}\n${fence}`;
}
