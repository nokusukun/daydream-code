/** Debug panel: GET /api/fibers — find the silently-PENDING plugin. */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useHarness } from "../harness.js";
import type { FiberDump } from "../api.js";

export function FibersPanel(): ReactNode {
  const { api, resyncTick } = useHarness();
  const [fibers, setFibers] = useState<FiberDump[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    api
      .fibers()
      .then(setFibers)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [api]);

  useEffect(refetch, [refetch, resyncTick]);

  return (
    <div className="view view-fibers">
      <div className="view-toolbar">
        <h2>fibers</h2>
        <button type="button" onClick={refetch}>
          refresh
        </button>
        <span className="toolbar-meta">{fibers.length} fibers</span>
      </div>
      {error !== null && <div className="error-bar">{error}</div>}
      <div className="feed">
        <table className="fiber-table">
          <thead>
            <tr>
              <th>state</th>
              <th>name</th>
              <th>inject</th>
              <th>missing</th>
              <th>effects</th>
              <th>error</th>
            </tr>
          </thead>
          <tbody>
            {fibers.map((fiber) => (
              <tr key={fiber.uid} className={`fiber-${fiber.state}`}>
                <td>{fiber.state}</td>
                <td>{fiber.name}</td>
                <td>{fiber.inject.join(", ")}</td>
                <td className={fiber.missing.length > 0 ? "fiber-missing" : ""}>
                  {fiber.missing.join(", ")}
                </td>
                <td>{fiber.effects.length}</td>
                <td className="fiber-error-cell">{fiber.error ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
