import { describe, expect, it } from "vitest";
import { createScreenKeeper } from "../electron/power-save.js";

/** A fake powerSaveBlocker: unique ids, and a ledger of what is held. */
function fakeBlocker(): {
  deps: { start(): number; stop(id: number): void };
  started: number[];
  stopped: number[];
  held(): number[];
} {
  const started: number[] = [];
  const stopped: number[] = [];
  let nextId = 100;
  return {
    deps: {
      start: () => {
        const id = nextId++;
        started.push(id);
        return id;
      },
      stop: (id: number) => {
        stopped.push(id);
      },
    },
    started,
    stopped,
    held: () => started.filter((id) => !stopped.includes(id)),
  };
}

describe("createScreenKeeper", () => {
  it("starts one blocker on the first true vote and no more after", () => {
    const blocker = fakeBlocker();
    const keeper = createScreenKeeper(blocker.deps);
    expect(keeper.set(1, true)).toEqual({ ok: true, active: true });
    expect(keeper.set(2, true)).toEqual({ ok: true, active: true });
    expect(keeper.set(1, true)).toEqual({ ok: true, active: true });
    expect(blocker.started).toHaveLength(1);
  });

  it("releases only when every voter has released", () => {
    const blocker = fakeBlocker();
    const keeper = createScreenKeeper(blocker.deps);
    keeper.set(1, true);
    keeper.set(2, true);
    expect(keeper.set(1, false)).toEqual({ ok: true, active: true });
    expect(blocker.held()).toHaveLength(1);
    expect(keeper.set(2, false)).toEqual({ ok: true, active: false });
    expect(blocker.held()).toHaveLength(0);
  });

  it("drop() releases a vanished window's vote", () => {
    const blocker = fakeBlocker();
    const keeper = createScreenKeeper(blocker.deps);
    keeper.set(7, true);
    keeper.drop(7);
    expect(keeper.active()).toBe(false);
    expect(blocker.held()).toHaveLength(0);
  });

  it("drop() of a sender that never voted touches nothing", () => {
    const blocker = fakeBlocker();
    const keeper = createScreenKeeper(blocker.deps);
    keeper.set(1, true);
    keeper.drop(99);
    expect(keeper.active()).toBe(true);
    expect(blocker.stopped).toHaveLength(0);
  });

  it("refuses a non-boolean payload without changing state", () => {
    const blocker = fakeBlocker();
    const keeper = createScreenKeeper(blocker.deps);
    keeper.set(1, true);
    for (const bad of ["true", 1, null, undefined, {}, { active: true }]) {
      expect(keeper.set(1, bad)).toEqual({
        ok: false,
        error: "invalid keep-awake request",
      });
    }
    expect(keeper.active()).toBe(true);
    expect(blocker.started).toHaveLength(1);
    expect(blocker.stopped).toHaveLength(0);
  });

  it("a false vote from a stranger is a no-op, not a release", () => {
    const blocker = fakeBlocker();
    const keeper = createScreenKeeper(blocker.deps);
    keeper.set(1, true);
    expect(keeper.set(2, false)).toEqual({ ok: true, active: true });
    expect(blocker.held()).toHaveLength(1);
  });

  it("starts a fresh blocker after a full release", () => {
    const blocker = fakeBlocker();
    const keeper = createScreenKeeper(blocker.deps);
    keeper.set(1, true);
    keeper.set(1, false);
    keeper.set(1, true);
    expect(blocker.started).toHaveLength(2);
    // The stopped id is the first one — never a stale stop of the live one.
    expect(blocker.stopped).toEqual([blocker.started[0]]);
  });

  it("dispose releases everything", () => {
    const blocker = fakeBlocker();
    const keeper = createScreenKeeper(blocker.deps);
    keeper.set(1, true);
    keeper.set(2, true);
    keeper.dispose();
    expect(keeper.active()).toBe(false);
    expect(blocker.held()).toHaveLength(0);
  });
});
