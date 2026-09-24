/**
 * Holding a board card peeks at its thread until release. The tracker owns
 * the rules; these pin the ones a person would feel: a click is not a hold,
 * a drag is not a hold, and letting go of a peek does not also open the
 * thread.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOLD_MS, SLOP_PX, createPressTracker } from "../src/long-press.js";

describe("press tracker", () => {
  let log: string[];
  beforeEach(() => {
    vi.useFakeTimers();
    log = [];
  });
  afterEach(() => vi.useRealTimers());

  const make = () =>
    createPressTracker({ onPeek: () => log.push("peek"), onRelease: () => log.push("release") });

  it("peeks after the hold and closes on release", () => {
    const t = make();
    t.down(10, 10);
    vi.advanceTimersByTime(HOLD_MS - 1);
    expect(log).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(log).toEqual(["peek"]);
    expect(t.peeking).toBe(true);
    t.end();
    expect(log).toEqual(["peek", "release"]);
    expect(t.peeking).toBe(false);
  });

  it("swallows exactly the click that ends a peek", () => {
    const t = make();
    t.down(0, 0);
    vi.advanceTimersByTime(HOLD_MS);
    t.end();
    expect(t.consumeClick()).toBe(true);
    // The next click is a real one.
    expect(t.consumeClick()).toBe(false);
  });

  it("a quick click never peeks and is not swallowed", () => {
    const t = make();
    t.down(0, 0);
    vi.advanceTimersByTime(HOLD_MS / 2);
    t.end();
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(log).toEqual([]);
    expect(t.consumeClick()).toBe(false);
  });

  it("gives up once the pointer moves past the slop, so a drag stays a drag", () => {
    const t = make();
    t.down(0, 0);
    t.move(SLOP_PX, 0);
    vi.advanceTimersByTime(HOLD_MS / 2);
    // Within the slop: still armed.
    expect(log).toEqual([]);
    t.move(SLOP_PX + 1, 0);
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(log).toEqual([]);
    expect(t.peeking).toBe(false);
  });

  it("a release that fired no click does not eat the next press's click", () => {
    const t = make();
    t.down(0, 0);
    vi.advanceTimersByTime(HOLD_MS);
    t.end();
    // No click arrived (released off the card). The next press is a fresh
    // gesture and its click must go through.
    t.down(0, 0);
    t.end();
    expect(t.consumeClick()).toBe(false);
  });

  it("dispose cancels a pending hold", () => {
    const t = make();
    t.down(0, 0);
    t.dispose();
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(log).toEqual([]);
  });
});
