/**
 * SplitPane: two children separated by a draggable handle. The second child
 * has a fixed size (px) the handle adjusts; the first flexes. Sizes persist
 * per `id` in localStorage; double-click resets to the initial size.
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
  /** Initial size (px) of the second child. */
  initial: number;
  min: number;
  max: number;
  first: ReactNode;
  second: ReactNode;
  className?: string;
}): ReactNode {
  const { id, direction, initial, min, max } = props;
  const isRow = direction === "row";
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(() => loadSize(id, initial));
  const drag = useRef<{ startPos: number; startSize: number; limit: number } | null>(null);

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
      // The second pane sits after the handle, so dragging toward it shrinks it.
      setSize(clamp(state.startSize + (state.startPos - pos), state.limit));
    },
    [isRow, clamp],
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

  return (
    <div
      ref={containerRef}
      className={`split split-${direction}${props.className !== undefined ? ` ${props.className}` : ""}`}
    >
      <div className="split-first">{props.first}</div>
      <div
        className="split-handle"
        role="separator"
        aria-orientation={isRow ? "vertical" : "horizontal"}
        title="drag to resize · double-click to reset"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={reset}
      />
      <div
        className="split-second"
        style={isRow ? { width: size } : { height: size }}
      >
        {props.second}
      </div>
    </div>
  );
}
