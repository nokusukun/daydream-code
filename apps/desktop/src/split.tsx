/**
 * SplitPane: two children separated by a draggable handle. One child has a
 * fixed size (px) the handle adjusts; the other flexes. Sizes persist per `id`
 * in localStorage; double-click resets to the initial size.
 *
 * `fixed` says which child is sized, because both arrangements occur: an
 * inspector on the trailing edge sizes the second, a sidebar on the leading
 * edge sizes the first. The clamp is the same either way — it always reserves
 * room for whichever pane flexes.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

const storageKey = (id: string): string => `ddc.split.${id}`;

function loadSize(id: string, fallback: number): number {
  try {
    const raw = window.localStorage.getItem(storageKey(id));
    const parsed = raw === null ? NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function saveSize(id: string, size: number): void {
  try {
    window.localStorage.setItem(storageKey(id), String(Math.round(size)));
  } catch {
    // storage unavailable — resizing still works, it just won't persist
  }
}

export function SplitPane(props: {
  id: string;
  direction: "row" | "column";
  /** Which child the handle sizes. The other one flexes. */
  fixed?: "first" | "second";
  /** Initial size (px) of the fixed child. */
  initial: number;
  min: number;
  max: number;
  first: ReactNode;
  second: ReactNode;
  className?: string;
  /** What the handle resizes, for the accessible name. */
  label?: string;
}): ReactNode {
  const { id, direction, initial, min, max } = props;
  const fixed = props.fixed ?? "second";
  const isRow = direction === "row";
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(() => loadSize(id, initial));
  const drag = useRef<{ startPos: number; startSize: number; limit: number } | null>(null);
  // Mirrors `size` for handlers that fire faster than a render.
  const sizeRef = useRef(size);
  sizeRef.current = size;

  // Re-clamp when the id changes (view switches reuse the component).
  useEffect(() => setSize(loadSize(id, initial)), [id, initial]);

  const clamp = useCallback(
    // min applies last: in a degenerate tiny window the pane stays at least
    // min-sized (and grabbable) rather than collapsing to the container limit.
    (value: number, limit: number): number =>
      Math.max(min, Math.min(value, Math.min(max, limit))),
    [min, max],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const container = containerRef.current;
      if (container === null) return;
      const rect = container.getBoundingClientRect();
      // Leave the first pane at least 25% / 160px, whichever is larger.
      const limit =
        (isRow ? rect.width : rect.height) - Math.max(160, (isRow ? rect.width : rect.height) * 0.25);
      drag.current = {
        startPos: isRow ? event.clientX : event.clientY,
        startSize: size,
        limit,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    [isRow, size],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const state = drag.current;
      if (state === null) return;
      const pos = isRow ? event.clientX : event.clientY;
      // Dragging toward the fixed pane shrinks it, so the sign depends on which
      // side of the handle that pane is on.
      const travel = fixed === "second" ? state.startPos - pos : pos - state.startPos;
      setSize(clamp(state.startSize + travel, state.limit));
    },
    [isRow, clamp, fixed],
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (drag.current === null) return;
      drag.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
      saveSize(id, size);
    },
    [id, size],
  );

  const reset = useCallback(() => {
    setSize(initial);
    saveSize(id, initial);
  }, [id, initial]);

  /**
   * Keyboard resize, because a separator that only answers to a pointer is a
   * pane the keyboard cannot reach the far side of.
   *
   * The arrow keys that move it are the ones that point along the axis it
   * travels, and the sign follows the same rule the drag does: which side the
   * sized pane sits on decides whether "away" grows or shrinks it.
   */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Home" || event.key === "Enter") {
        event.preventDefault();
        reset();
        return;
      }
      const decrease = isRow ? "ArrowLeft" : "ArrowUp";
      const increase = isRow ? "ArrowRight" : "ArrowDown";
      if (event.key !== decrease && event.key !== increase) return;
      event.preventDefault();
      const container = containerRef.current;
      const span =
        container === null
          ? Infinity
          : isRow
            ? container.getBoundingClientRect().width
            : container.getBoundingClientRect().height;
      const limit = span - Math.max(160, span * 0.25);
      // Coarse by default, fine with Shift, the way a Mac slider behaves.
      const step = event.shiftKey ? 1 : 16;
      const toward = event.key === increase ? 1 : -1;
      const delta = (fixed === "second" ? -toward : toward) * step;
      // Read through the ref, not the closed-over `size`: key repeat fires
      // faster than React re-renders, and three presses against one stale
      // value moved the pane once instead of three times.
      const next = clamp(sizeRef.current + delta, limit);
      sizeRef.current = next;
      setSize(next);
      saveSize(id, next);
    },
    [clamp, fixed, id, isRow, reset],
  );

  return (
    <div
      ref={containerRef}
      className={`split split-${direction} split-fixed-${fixed}${props.className !== undefined ? ` ${props.className}` : ""}`}
    >
      <div
        className="split-first"
        {...(fixed === "first"
          ? { style: isRow ? { width: size } : { height: size } }
          : {})}
      >
        {props.first}
      </div>
      <div
        className="split-handle"
        role="separator"
        tabIndex={0}
        aria-orientation={isRow ? "vertical" : "horizontal"}
        aria-label={props.label ?? "Resize panes"}
        aria-valuenow={Math.round(size)}
        aria-valuemin={min}
        aria-valuemax={max}
        title="drag to resize · double-click to reset"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={reset}
        onKeyDown={onKeyDown}
      />
      <div
        className="split-second"
        {...(fixed === "second"
          ? { style: isRow ? { width: size } : { height: size } }
          : {})}
      >
        {props.second}
      </div>
    </div>
  );
}
