/**
 * Dismissal and focus behaviour shared by every popover, sheet and palette.
 *
 * Its own module because three views were importing it from `ActivityMenu`,
 * which made a menu the owner of a rule the whole window obeys, and because
 * the four overlays that hand-rolled Escape got it subtly wrong in the same
 * way: they listened on the dialog element, so one Tab past the last control
 * put focus behind the scrim and Escape stopped working while the scrim still
 * blocked the mouse. A document-level listener has no such dead end.
 */
import { useEffect, useRef, type RefObject } from "react";

/**
 * Move focus into a modal surface on mount.
 *
 * Opt-in rather than folded into `useDismiss`, because the trigger-anchored
 * popovers want focus to stay on their trigger: the menu is a peek, and taking
 * focus would make Tab resume from somewhere the person never went. A sheet is
 * the opposite, and one that does not claim focus leaves Tab starting from
 * `<body>`, outside the thing covering the screen.
 *
 * Focus lands on the container, not the first control, so a screen reader
 * announces what opened before it announces what to do about it.
 */
export function useInitialFocus(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const node = ref.current;
    if (node === null) return;
    if (node.contains(document.activeElement)) return;
    node.focus();
  }, [ref]);
}

/**
 * Close on an outside click or Escape, and put focus back where it was.
 *
 * Focus restore is folded in here rather than offered separately because an
 * overlay that forgets it drops the keyboard user on `<body>`, which is the
 * one place from which nothing is reachable by Tab.
 *
 * The restore is conditional: an overlay whose action deliberately moves focus
 * elsewhere (opening a project, selecting a file) must not have it yanked
 * back, so it only fires when focus is still inside the overlay or has already
 * fallen to the body.
 */
export function useDismiss(
  ref: React.RefObject<HTMLElement | null>,
  open: boolean,
  close: () => void,
): void {
  const restoreTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement;
    restoreTo.current = opener instanceof HTMLElement ? opener : null;

    const onDown = (event: MouseEvent): void => {
      if (!ref.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);

      const target = restoreTo.current;
      restoreTo.current = null;
      if (target === null || !target.isConnected) return;
      const active = document.activeElement;
      const stranded = active === null || active === document.body;
      const inside = active instanceof Node && ref.current?.contains(active) === true;
      if (stranded || inside) target.focus();
    };
  }, [ref, open, close]);
}
