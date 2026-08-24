import { describe, expect, it } from "vitest";
import { DraftStore, draftPreview, type StorageLike } from "../src/drafts.js";

/** Minimal `localStorage` stand-in: same surface, no DOM. */
class FakeStorage implements StorageLike {
  readonly map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

function store(
  storage: StorageLike,
  overrides: { scope?: string; now?: () => number } = {},
): DraftStore {
  return new DraftStore({
    scope: overrides.scope ?? "/repo",
    storage,
    writeDelayMs: 0,
    ...(overrides.now !== undefined ? { now: overrides.now } : {}),
  });
}

describe("DraftStore", () => {
  it("reads back what was typed", () => {
    const drafts = store(new FakeStorage());
    drafts.set("ses_1", "half a thought");
    expect(drafts.get("ses_1")).toBe("half a thought");
    expect(drafts.get("ses_2")).toBe("");
  });

  it("survives the composer unmounting and the window reloading", () => {
    const storage = new FakeStorage();
    store(storage).set("ses_1", "unsent");
    // A fresh store is what a reload — or a remount after switching — sees.
    expect(store(storage).get("ses_1")).toBe("unsent");
  });

  it("keeps projects apart", () => {
    const storage = new FakeStorage();
    store(storage, { scope: "/a" }).set("new", "for a");
    store(storage, { scope: "/b" }).set("new", "for b");
    expect(store(storage, { scope: "/a" }).get("new")).toBe("for a");
    expect(store(storage, { scope: "/b" }).get("new")).toBe("for b");
  });

  it("leaves nothing behind once the message is sent", () => {
    const storage = new FakeStorage();
    const drafts = store(storage);
    drafts.set("ses_1", "sent in a moment");
    drafts.clear("ses_1");
    expect(drafts.get("ses_1")).toBe("");
    expect(drafts.keys()).toEqual([]);
    expect(storage.map.size).toBe(0);
  });

  it("treats an emptied composer as no draft", () => {
    const storage = new FakeStorage();
    const drafts = store(storage);
    drafts.set("ses_1", "typed");
    drafts.set("ses_1", "");
    expect(drafts.keys()).toEqual([]);
    expect(storage.map.size).toBe(0);
  });

  it("lists the sessions holding a draft", () => {
    const drafts = store(new FakeStorage());
    drafts.set("ses_1", "one");
    drafts.set("new", "two");
    expect(new Set(drafts.keys())).toEqual(new Set(["ses_1", "new"]));
  });

  it("notifies subscribers and hands out a fresh snapshot per change", () => {
    const drafts = store(new FakeStorage());
    let calls = 0;
    const stop = drafts.subscribe(() => {
      calls += 1;
    });
    const before = drafts.snapshot();
    drafts.set("ses_1", "x");
    expect(calls).toBe(1);
    expect(drafts.snapshot()).not.toBe(before);
    expect(drafts.snapshot().get("ses_1")).toBe("x");
    // Re-typing the same text is not a change, so React does not re-render.
    drafts.set("ses_1", "x");
    expect(calls).toBe(1);
    stop();
    drafts.set("ses_1", "y");
    expect(calls).toBe(1);
  });

  it("coalesces writes and flushes on demand", () => {
    const storage = new FakeStorage();
    const drafts = new DraftStore({ scope: "/repo", storage, writeDelayMs: 5_000 });
    drafts.set("ses_1", "typing…");
    expect(storage.map.size).toBe(0);
    drafts.flush();
    expect(store(storage).get("ses_1")).toBe("typing…");
  });

  it("ignores entries it cannot parse", () => {
    const storage = new FakeStorage();
    storage.setItem("daydream.draft.%2Frepo.ses_1", "{not json");
    storage.setItem("daydream.draft.%2Frepo.ses_2", JSON.stringify({ at: 1 }));
    storage.setItem("unrelated.key", "left alone");
    const drafts = store(storage);
    expect(drafts.keys()).toEqual([]);
    expect(storage.getItem("unrelated.key")).toBe("left alone");
  });

  it("drops drafts that have gone stale", () => {
    const storage = new FakeStorage();
    let clock = 1_000_000;
    store(storage, { now: () => clock }).set("ses_old", "last month");
    clock += 31 * 24 * 60 * 60 * 1000;
    const drafts = store(storage, { now: () => clock });
    expect(drafts.keys()).toEqual([]);
    expect(storage.map.size).toBe(0);
  });

  it("keeps only the most recent drafts", () => {
    const storage = new FakeStorage();
    let clock = 1_000;
    const writer = new DraftStore({
      scope: "/repo",
      storage,
      writeDelayMs: 0,
      now: () => (clock += 1_000),
    });
    for (let i = 0; i < 5; i += 1) writer.set(`ses_${i}`, `draft ${i}`);
    const drafts = new DraftStore({
      scope: "/repo",
      storage,
      writeDelayMs: 0,
      now: () => clock,
      maxEntries: 2,
    });
    expect(new Set(drafts.keys())).toEqual(new Set(["ses_4", "ses_3"]));
    expect(storage.map.size).toBe(2);
  });

  it("carries fields it does not understand through a rewrite", () => {
    // The composer will hold pending attachments once paste/drop lands; a
    // version that predates that must not strip them off someone's draft.
    const storage = new FakeStorage();
    const key = "daydream.draft.%2Frepo.ses_1";
    storage.setItem(
      key,
      JSON.stringify({ text: "look at this", at: 10, attachments: [{ path: "shot.png" }] }),
    );
    const drafts = store(storage, { now: () => 20 });
    expect(drafts.get("ses_1")).toBe("look at this");
    drafts.set("ses_1", "look at this instead");
    const written: unknown = JSON.parse(storage.getItem(key) ?? "null");
    expect(written).toEqual({
      text: "look at this instead",
      at: 20,
      attachments: [{ path: "shot.png" }],
    });
  });

  it("works without any storage at all", () => {
    const drafts = new DraftStore({ scope: "/repo", storage: null });
    drafts.set("ses_1", "memory only");
    drafts.flush();
    expect(drafts.get("ses_1")).toBe("memory only");
  });
});

describe("draftPreview", () => {
  it("shows the first line", () => {
    expect(draftPreview("  first\nsecond  ")).toBe("first");
  });

  it("truncates long lines", () => {
    expect(draftPreview("x".repeat(50), 10)).toBe(`${"x".repeat(9)}…`);
  });

  it("is empty for empty text", () => {
    expect(draftPreview("   ")).toBe("");
  });
});
