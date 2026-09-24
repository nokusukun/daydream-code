/**
 * The visible sidebar toggle in the toolbar's trailing action group. ⌘B and
 * the palette already flip the rail, but neither is discoverable from the
 * chrome, and the leading toolbar slot that once held this button is quick
 * actions now — so the visible affordance lives with the other view controls.
 *
 * The caller renders it only when the active mode contributes a sidebar:
 * Terminal opted out of having one on purpose, and a toggle that could never
 * act would read as broken rather than inapplicable.
 */
import type { ReactNode } from "react";

export function SidebarToggle(props: {
  visible: boolean;
  onToggle(): void;
}): ReactNode {
  return (
    <button
      type="button"
      className="toolbar-icon sidebar-toggle"
      aria-label={props.visible ? "Hide sidebar" : "Show sidebar"}
      aria-pressed={props.visible}
      aria-keyshortcuts="Meta+B"
      title={`${props.visible ? "Hide" : "Show"} sidebar (⌘B)`}
      onClick={props.onToggle}
    >
      <svg
        viewBox="0 0 16 16"
        width="15"
        height="15"
        aria-hidden="true"
        focusable="false"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      >
        <rect x="1.75" y="3" width="12.5" height="10" rx="2" />
        <path d="M6.25 3v10" />
        {/* The filled bar in the left pane is the state: present while the
            rail shows, gone once it is hidden. */}
        {props.visible && (
          <rect
            x="3.3"
            y="4.6"
            width="1.5"
            height="6.8"
            rx="0.75"
            fill="currentColor"
            stroke="none"
          />
        )}
      </svg>
    </button>
  );
}
