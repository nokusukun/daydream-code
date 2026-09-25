/**
 * Marking finished cards read.
 *
 * A Done card is read once a person has had its thread on screen, in a
 * focused window, since it finished. The views that draw a thread only
 * announce that they are drawing it (`useShownThread`); they know nothing of
 * the board. The board module's driver (`useMarkRead`) joins those
 * announcements with the cards and reports the reads. Opening the thread from
 * the card, the sidebar or the palette all count, because every one of them
 * mounts the same panel. So does already watching the thread when the card
 * lands in Done.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { BoardCard } from "./api.js";
import { isUnread, useBoard } from "./board.js";
import { useHarness } from "./harness.js";

/** `open` is a thread panel. `peek` is the long-press preview, which a setting may discount. */
export type ShownKind = "open" | "peek";

export interface ShownThread {
  sessionId: string;
  kind: ShownKind;
}

// Keyed by registration, not by session: the same thread can be in the main
// pane and a peek at once, and one of them closing must not un-show the other.
const shown = new Map<symbol, ShownThread>();
let snapshot: readonly ShownThread[] = [];
const listeners = new Set<() => void>();

function publish(): void {
  snapshot = [...shown.values()];
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Announce that this component is drawing a thread, for as long as it is mounted. */
export function useShownThread(sessionId: string | null, kind: ShownKind): void {
  useEffect(() => {
    if (sessionId === null) return;
    const key = Symbol(sessionId);
    shown.set(key, { sessionId, kind });
    publish();
    return () => {
      shown.delete(key);
      publish();
    };
  }, [sessionId, kind]);
}

export function useShownThreads(): readonly ShownThread[] {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

/**
 * The cards that became read: unread, and their thread is on screen in a way
 * that counts. Nothing counts in a window the person is not looking at. A
 * thread left open behind another app does not tell anyone it finished.
 */
export function readNow(
  cards: readonly Pick<BoardCard, "id" | "column" | "seenAt" | "sessionId">[],
  threads: readonly ShownThread[],
  options: { peekMarksRead: boolean; focused: boolean },
): string[] {
  if (!options.focused) return [];
  const visible = new Set(
    threads.filter((t) => t.kind === "open" || options.peekMarksRead).map((t) => t.sessionId),
  );
  return cards
    .filter((card) => isUnread(card) && card.sessionId !== null && visible.has(card.sessionId))
    .map((card) => card.id);
}

function isFocused(): boolean {
  if (typeof document === "undefined") return false;
  return document.visibilityState === "visible" && document.hasFocus();
}

export function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(isFocused);
  useEffect(() => {
    const update = () => setFocused(isFocused());
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  return focused;
}

/**
 * Report reads to the board. Renders nothing; the board module mounts it in
 * the toolbar so it runs in every mode, since the thread a card points at is
 * opened in agent mode, not on the board.
 */
export function useMarkRead(): void {
  const { api } = useHarness();
  const board = useBoard();
  const threads = useShownThreads();
  const focused = useWindowFocused();
  // Cards already reported. The frame that clears them from `readNow` can take
  // a moment to arrive, and each render in between would post again.
  const sent = useRef(new Set<string>());

  const ids = readNow(board.cards, threads, {
    peekMarksRead: board.display.peekMarksRead,
    focused,
  });
  const key = ids.join(",");

  useEffect(() => {
    for (const id of key === "" ? [] : key.split(",")) {
      if (sent.current.has(id)) continue;
      sent.current.add(id);
      // A failed report leaves the card unread, which is the honest state;
      // forgetting it lets the next render try again.
      api.markCardSeen(id).catch(() => sent.current.delete(id));
    }
  }, [api, key]);

  // A card that finishes again is unread again and must be reportable again.
  useEffect(() => {
    for (const id of sent.current) {
      const card = board.cards.find((c) => c.id === id);
      if (card === undefined || !isUnread(card)) sent.current.delete(id);
    }
  }, [board.cards]);
}
