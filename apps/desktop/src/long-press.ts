/**
 * Press-and-hold to peek, release to put it away.
 *
 * The rules live in a plain tracker rather than in the hook so they can be
 * tested without a DOM, and because the three ways a hold ends — the pointer
 * comes up, the press turns into a drag, the window loses the pointer — have
 * to agree on one thing: the click that follows a peek must not also open the
 * thread. A peek is a look, and releasing it should leave you where you were.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

/** Long enough that an ordinary click never trips it, short enough to feel held. */
export const HOLD_MS = 380;
/**
 * How far the pointer may wander before the press counts as a drag instead.
 * Board cards are draggable, and Chromium starts a drag after a few pixels;
 * the tracker must give up first, or a reorder would open a peek mid-drag.
 */
export const SLOP_PX = 6;

export interface PressTrackerOptions {
  holdMs?: number;
  slopPx?: number;
  onPeek(): void;
  onRelease(): void;
  schedule?: (run: () => void, ms: number) => unknown;
  unschedule?: (handle: unknown) => void;
}

export interface PressTracker {
  down(x: number, y: number): void;
  move(x: number, y: number): void;
  /** Pointer up, cancel, blur, Escape: every way a press can end. */
  end(): void;
  /** True while the peek is showing. */
  readonly peeking: boolean;
  /**
   * Called from the click handler: true means this click is the tail of a
   * peek and must be swallowed. Answers once, then forgets.
   */
  consumeClick(): boolean;
  dispose(): void;
}

export function createPressTracker(options: PressTrackerOptions): PressTracker {
  const holdMs = options.holdMs ?? HOLD_MS;
  const slop = options.slopPx ?? SLOP_PX;
  const schedule = options.schedule ?? ((run, ms) => setTimeout(run, ms));
  const unschedule = options.unschedule ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let timer: unknown = null;
  let origin: { x: number; y: number } | null = null;
  let peeking = false;
  // Set when a peek opens, cleared by the click it swallows or by the next
  // press. The second reset matters: a release that lands off the card fires
  // no click on it, and a flag left standing would eat the next real one.
  let swallow = false;

  const disarm = () => {
    if (timer !== null) unschedule(timer);
    timer = null;
    origin = null;
  };

  return {
    down(x, y) {
      disarm();
      swallow = false;
      origin = { x, y };
      timer = schedule(() => {
        timer = null;
        origin = null;
        peeking = true;
        swallow = true;
        options.onPeek();
      }, holdMs);
    },
    move(x, y) {
      if (origin === null) return;
      if (Math.hypot(x - origin.x, y - origin.y) > slop) disarm();
    },
    end() {
      disarm();
      if (!peeking) return;
      peeking = false;
      options.onRelease();
    },
    get peeking() {
      return peeking;
    },
    consumeClick() {
      const was = swallow;
      swallow = false;
      return was;
    },
    dispose() {
      disarm();
      peeking = false;
    },
  };
}

export interface LongPress {
  peeking: boolean;
  /** Spread on the pressable element. */
  bind: {
    onPointerDown(event: PointerEvent<HTMLElement>): void;
    onPointerMove(event: PointerEvent<HTMLElement>): void;
    onKeyUp(event: KeyboardEvent<HTMLElement>): void;
  };
  /**
   * Space held on the focused element peeks, like Quick Look. Returns true
   * when it handled the key, so the element's own key handler can stand down.
   */
  keyDown(event: KeyboardEvent<HTMLElement>): boolean;
  consumeClick(): boolean;
  end(): void;
}

/**
 * The hook over the tracker. Presses that start on a control inside the
 * element are ignored: holding the archive button is holding a button.
 */
export function useLongPress(enabled: boolean): LongPress {
  const [peeking, setPeeking] = useState(false);
  const tracker = useRef<PressTracker | null>(null);
  if (tracker.current === null) {
    tracker.current = createPressTracker({
      onPeek: () => setPeeking(true),
      onRelease: () => setPeeking(false),
    });
  }
  const t = tracker.current;

  useEffect(() => () => t.dispose(), [t]);
  useEffect(() => {
    if (!enabled) t.end();
  }, [enabled, t]);

  // The release is listened for on the window, not the element: the peek
  // covers the card the moment it opens, so the pointer comes up over the
  // peek, and it may have wandered anywhere by then.
  useEffect(() => {
    if (!peeking) return;
    const end = () => t.end();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" || (event.type === "keyup" && event.key === " ")) end();
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("blur", end);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", end);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
  }, [peeking, t]);

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (!enabled || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
      if ((event.target as HTMLElement).closest("button, a, textarea, input") !== null) return;
      t.down(event.clientX, event.clientY);
      // A press that never becomes a peek still has to disarm when it ends
      // short, or a quick click would open one 380ms later.
      const disarm = () => {
        window.removeEventListener("pointerup", disarm);
        window.removeEventListener("pointercancel", disarm);
        if (!t.peeking) t.end();
      };
      window.addEventListener("pointerup", disarm);
      window.addEventListener("pointercancel", disarm);
    },
    [enabled, t],
  );
  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLElement>) => t.move(event.clientX, event.clientY),
    [t],
  );
  const keyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (!enabled || event.key !== " " || event.target !== event.currentTarget) return false;
      // Held Space repeats; the peek is already open, and the default would
      // scroll the lane behind it.
      event.preventDefault();
      if (!event.repeat && !t.peeking) {
        t.down(0, 0);
      }
      return true;
    },
    [enabled, t],
  );
  const onKeyUp = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === " ") t.end();
    },
    [t],
  );

  return {
    peeking,
    bind: { onPointerDown, onPointerMove, onKeyUp },
    keyDown,
    consumeClick: () => t.consumeClick(),
    end: () => t.end(),
  };
}
