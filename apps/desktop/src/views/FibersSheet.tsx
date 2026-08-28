/**
 * Plugin fiber state, as an overlay sheet. This is a debugging surface: it
 * answers "which plugin is silently PENDING" and nothing else, so it earns an
 * overlay rather than permanent space in the workspace.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { FiberDump } from "../api.js";
import { useHarness } from "../harness.js";
import { useDismiss, useInitialFocus } from "../overlay.js";

export function FibersSheet(): ReactNode {
  const { api, setOverlay } = useHarness();
  const [fibers, setFibers] = useState<FiberDump[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .fibers()
      .then((list) => {
        if (!cancelled) setFibers(list);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const stuck = fibers?.filter((f) => f.state !== "active").length ?? 0;
  const sheetRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOverlay(null), [setOverlay]);
  useDismiss(sheetRef, true, close);
  useInitialFocus(sheetRef);

  return (
    <div
      className="scrim"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOverlay(null);
      }}
    >
      <div
        ref={sheetRef}
        className="sheet glass-strong"
        role="dialog"
        aria-modal="true"
        aria-label="Plugin fibers"
        tabIndex={-1}
      >
        <header className="sheet-head">
          <h2>plugin fibers</h2>
          {fibers !== null && (
            <span className="palette-hint">
              {stuck === 0
                ? `all ${fibers.length} active`
                : `${stuck} of ${fibers.length} not active`}
            </span>
          )}
          <button
            type="button"
            className="btn"
            autoFocus
            onClick={() => setOverlay(null)}
          >
            done
          </button>
        </header>
        <div className="sheet-body">
          {error !== null && <div className="error-bar">{error}</div>}
          {fibers === null && error === null && (
            <div aria-busy="true" style={{ display: "grid", gap: 6 }}>
              <div className="skeleton" style={{ height: 28 }} />
              <div className="skeleton" style={{ height: 28, opacity: 0.6 }} />
              <div className="skeleton" style={{ height: 28, opacity: 0.3 }} />
            </div>
          )}
          {fibers !== null && (
            <table className="fibers">
              <thead>
                <tr>
                  <th>plugin</th>
                  <th>state</th>
                  <th>missing</th>
                  <th>error</th>
                </tr>
              </thead>
              <tbody>
                {fibers.map((fiber) => (
                  <tr key={fiber.uid} className={`fiber-${fiber.state}`}>
                    <td>{fiber.name}</td>
                    <td>{fiber.state}</td>
                    <td>{fiber.missing.length > 0 ? fiber.missing.join(", ") : "—"}</td>
                    <td className={fiber.error !== undefined ? "fiber-err" : ""}>
                      {fiber.error ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
