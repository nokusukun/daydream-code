/**
 * Native context menu for selectable, read-only prose.
 *
 * Electron does not create the browser's default context menu for us. Keep
 * this renderer-side so Code view can retain its richer file-aware menu while
 * transcript text gets the platform Copy affordance users expect.
 */
import type { MouseEvent as ReactMouseEvent } from "react";
import { bridge } from "./bridge.js";

export function openTextContextMenu(
  event: ReactMouseEvent<HTMLElement>,
): void {
  const selection = window.getSelection();
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return;

  const range = selection.getRangeAt(0);
  const common =
    range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
  if (common === null || !event.currentTarget.contains(common)) return;

  const text = selection.toString();
  if (text.trim().length === 0) return;

  const appBridge = bridge();
  if (appBridge === undefined) return;
  event.preventDefault();
  void appBridge.showTextContextMenu(text);
}
