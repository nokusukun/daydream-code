/**
 * The board's new-card popup.
 *
 * "+ New card" used to leave the board for agent mode's blank master panel,
 * which is the right door for a thread but the wrong one for a card: the card
 * lands back on the board, so the round trip was two view changes to write
 * one line. This keeps the board behind a scrim and puts the same composer in
 * front of it.
 *
 * It is the same `DispatchComposer`, not a card-shaped form, because that
 * composer is the one place a card can say which driver, model and effort
 * should run it (see its `create`), and it shares the new-task draft with the
 * master panel, so text typed in either is there in the other.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { DispatchComposer } from "./Composer.js";

export function NewCardSheet(props: { onClose(): void }): ReactNode {
  const { onClose } = props;
  const sheetRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  // Read during the first render, not in the effect: the composer's autofocus
  // is a child effect and runs first, so by then focus is already inside.
  // (No document under a static render, which is how the tests draw it.)
  const [opener] = useState(() => (typeof document === "undefined" ? null : document.activeElement));

  // Not `useDismiss`: the model and effort pickers portal their popovers to
  // the body (see model-selector.tsx), so an outside-click rule reads a click
  // on a model as a click on the board and closes the card under it. Escape
  // has the same trap. Here only a press on the scrim itself dismisses, and
  // Escape only counts when it came from inside the sheet (or from nowhere)
  // and nothing in the sheet already spent it — the skill menu closes on
  // Escape and marks the event handled.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target;
      const fromSheet = target instanceof Node && sheetRef.current?.contains(target) === true;
      if (!fromSheet && target !== document.body) return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      // Put focus back on "+ New card" so the keyboard user is where they
      // left, unless the lane re-rendered it away.
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [onClose, opener]);

  return (
    <div
      className="scrim new-card-scrim"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={sheetRef}
        className="sheet glass-strong new-card-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-card-title"
      >
        <header className="sheet-head">
          <h2 id="new-card-title">New card</h2>
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            Cancel
          </button>
        </header>
        {error !== null && (
          <div className="error-bar" role="alert">
            {error}
          </div>
        )}
        <DispatchComposer autoFocus onError={setError} onCreated={onClose} />
      </div>
    </div>
  );
}
