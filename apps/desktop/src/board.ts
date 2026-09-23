/**
 * The kanban board, kept live off the websocket.
 *
 * `enabled` is learned from the server, not from settings: the board routes
 * exist exactly when the project is in kanban mode, so `GET /api/board`
 * answering at all is the signal. A 404 is "not in kanban mode", which is a
 * normal state and not an error; anything else is.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, type BoardCard, type BoardColumn } from "./api.js";
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
