/**
 * Native context menu for selectable, read-only prose.
 *
 * Electron does not create the browser's default context menu for us. Keep
 * this renderer-side so Code view can retain its richer file-aware menu while
 * transcript text gets the platform Copy affordance users expect.
 */
import type { MouseEvent as ReactMouseEvent } from "react";
import { bridge } from "./bridge.js";

/** Selection wins; otherwise use the source attached to the row under the pointer. */
export function contextCopyText(
  selectionText: string,
  entryText: string,
): string | null {
  if (selectionText.trim().length > 0) return selectionText;
  if (entryText.trim().length > 0) return entryText;
  return null;
}

export function openTextContextMenu(
  event: ReactMouseEvent<HTMLElement>,
): void {
  const selection = window.getSelection();
  let selectionText = "";

  if (selection !== null && !selection.isCollapsed && selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    const common =
      range.commonAncestorContainer instanceof Element
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
    const target = event.target instanceof Element ? event.target : null;
    // A selection elsewhere in the feed must not hijack a right-click on a
    // different message. Native menus act on the thing under the pointer.
    if (
      common !== null &&
      target !== null &&
      event.currentTarget.contains(common) &&
      range.intersectsNode(target)
    ) {
      selectionText = selection.toString();
    }
  }

  let entryText = "";
  if (event.target instanceof Element) {
    const entry = event.target.closest<HTMLElement>(".entry[data-copy-text]");
    if (entry !== null && event.currentTarget.contains(entry)) {
      entryText = entry.dataset.copyText ?? "";
    }
  }
  const text = contextCopyText(selectionText, entryText);
  if (text === null) return;

  const appBridge = bridge();
  if (appBridge === undefined) return;
  event.preventDefault();
  void appBridge.showTextContextMenu(text);
}
