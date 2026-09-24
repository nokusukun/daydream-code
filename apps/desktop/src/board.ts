/**
 * The kanban board, kept live off the websocket.
 *
 * `enabled` is learned from the server, not from settings: the board routes
 * exist exactly when the project is in kanban mode, so `GET /api/board`
 * answering at all is the signal. A 404 is "not in kanban mode", which is a
 * normal state and not an error; anything else is.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, type ApiClient, type BoardCard, type BoardColumn } from "./api.js";
import { useHarness } from "./harness.js";

export interface BoardState {
  /** Null until the first answer; false when the project is not in kanban mode. */
  enabled: boolean | null;
  cards: BoardCard[];
  error: string | null;
  refresh(): void;
}

export function useBoard(): BoardState {
  const { api, subscribe, resyncTick } = useHarness();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [cards, setCards] = useState<BoardCard[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api
      .board()
      .then((board) => {
        if (cancelled) return;
        setError(null);
        setEnabled(board.enabled);
        setCards(board.cards);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (cause instanceof ApiError && cause.status === 404) {
          setEnabled(false);
          setCards([]);
          setError(null);
          return;
        }
        setError(cause instanceof ApiError ? (cause.detail ?? cause.message) : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [api, resyncTick, tick]);

  useEffect(
    () =>
      subscribe((frame) => {
        if (frame.kind === "board-removed") {
          setCards((prev) => prev.filter((card) => card.id !== frame.id));
          return;
        }
        if (frame.kind !== "board") return;
        // A frame proves the board exists, whatever the first fetch said.
        setEnabled(true);
        setCards((prev) => {
          const at = prev.findIndex((card) => card.id === frame.card.id);
          const next = at === -1 ? [...prev, frame.card] : prev.map((card, i) => (i === at ? frame.card : card));
          return next.sort((a, b) => a.position - b.position);
        });
      }),
    [subscribe],
  );

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  return useMemo(() => ({ enabled, cards, error, refresh }), [enabled, cards, error, refresh]);
}

/**
 * The composition rows that are kanban mode — the same four switches the
 * settings window's kanban section shows. Routes last: each write mounts its
 * row live, and the board asks `/api/board` the moment the flow resolves, so
 * the row that answers that request should be the one that cannot land
 * before the rows it depends on.
 */
export const KANBAN_ROWS = ["board", "board-evaluator", "board-writeback", "board-routes"] as const;

/**
 * Turn kanban mode on for this project, from the board screen itself.
 *
 * Writes to the project layer, not the user layer: kanban is a per-project
 * workflow (the board, its evaluators and its writeback all hang off one
 * project's sessions), and this is also where the settings window defaults.
 *
 * Returns null on success, or one sentence to show the person. A row that
 * saved but needs a restart is reported as that, not as a failure — the
 * switch did flip, the harness just cannot act on it yet.
 */
export async function enableKanban(api: Pick<ApiClient, "writeSetting">): Promise<string | null> {
  const problems: string[] = [];
  let restart = false;
  for (const id of KANBAN_ROWS) {
    try {
      const result = await api.writeSetting({ layer: "project", id, set: { disabled: false } });
      const outcome = result.outcomes.find((candidate) => candidate.id === id);
      if (outcome?.status === "failed") problems.push(`${id}: ${outcome.reason ?? "failed to start"}`);
      if (outcome?.status === "restart-required") restart = true;
    } catch (cause) {
      // The write itself failed, so nothing was saved for this row. The
      // remaining writes would fail the same way and leave kanban
      // half-configured with no report of which half; stop and say where.
      const detail = cause instanceof ApiError ? (cause.detail ?? cause.message) : String(cause);
      return `could not save ${id}: ${detail}`;
    }
  }
  if (problems.length > 0) return `kanban did not fully start — ${problems.join("; ")}`;
  if (restart) return "saved — restart Daydream Code to finish turning kanban on";
  return null;
}

/** The six lanes a person sees; Blocked lives inside Queued. */
export const LANES: ReadonlyArray<{ id: string; label: string; columns: readonly BoardColumn[] }> = [
  { id: "draft", label: "Drafts", columns: ["draft"] },
  { id: "queued", label: "Queued", columns: ["queued", "blocked"] },
  { id: "evaluating", label: "Evaluating", columns: ["evaluating"] },
  { id: "working", label: "Working", columns: ["working"] },
  { id: "attention", label: "Needs Attention", columns: ["attention"] },
  { id: "done", label: "Done", columns: ["done"] },
];

export function laneOf(card: BoardCard): string {
  return LANES.find((lane) => lane.columns.includes(card.column))?.id ?? "queued";
}
