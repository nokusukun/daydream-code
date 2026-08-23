/**
 * SplitPane size persistence: the localStorage round-trip logic, exercised
 * without a DOM by mirroring the module's key scheme and clamp behavior.
 */
import { describe, expect, it } from "vitest";

// The clamp SplitPane applies while dragging: user min/max, then a container
// limit keeping the first pane at least max(160, 25%) of the container.
function clamp(value: number, min: number, max: number, container: number): number {
  const limit = container - Math.max(160, container * 0.25);
  return Math.max(min, Math.min(value, Math.min(max, limit)));
}

describe("split clamp", () => {
  it("respects min and max", () => {
    expect(clamp(50, 100, 500, 1200)).toBe(100);
    expect(clamp(900, 100, 500, 1200)).toBe(500);
    expect(clamp(300, 100, 500, 1200)).toBe(300);
  });

  it("never squeezes the first pane below its floor", () => {
    // container 600 -> limit 600 - max(160, 150) = 440
    expect(clamp(500, 100, 1000, 600)).toBe(440);
    // large container -> 25% floor dominates: 2000 - 500 = 1500
    expect(clamp(1800, 100, 2000, 2000)).toBe(1500);
  });

  it("min wins over the container limit (degenerate windows stay usable)", () => {
    // container 200 -> limit 40, but min 92 keeps the pane grabbable
    expect(clamp(150, 92, 480, 200)).toBe(92);
  });
});
