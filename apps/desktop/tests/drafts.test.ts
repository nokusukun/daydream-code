import { describe, expect, it } from "vitest";
import {
  DraftStore,
  draftPreview,
  type Draft,
  type StorageLike,
} from "../src/drafts.js";
import type { Attachment } from "../src/attachments.js";

/** A draft is text plus images; most of these cases only care about the text. */
function type_(drafts: DraftStore, key: string, text: string): void {
  drafts.set(key, { text, attachments: [] });
}

function text_(drafts: DraftStore, key: string): string {
  return drafts.get(key).text;
}

const shot = (blobId: string, name?: string): Attachment => ({
  blobId,
  mediaType: "image/png",
  bytes: 12,
  width: 8,
  height: 4,
  ...(name !== undefined ? { name } : {}),
});

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
    type_(drafts, "ses_1", "half a thought");
    expect(text_(drafts, "ses_1")).toBe("half a thought");
    expect(text_(drafts, "ses_2")).toBe("");
  });

  it("survives the composer unmounting and the window reloading", () => {
    const storage = new FakeStorage();
    type_(store(storage), "ses_1", "unsent");
    // A fresh store is what a reload — or a remount after switching — sees.
    expect(text_(store(storage), "ses_1")).toBe("unsent");
  });

  it("keeps projects apart", () => {
    const storage = new FakeStorage();
    type_(store(storage, { scope: "/a" }), "new", "for a");
    type_(store(storage, { scope: "/b" }), "new", "for b");
    expect(text_(store(storage, { scope: "/a" }), "new")).toBe("for a");
    expect(text_(store(storage, { scope: "/b" }), "new")).toBe("for b");
  });

  it("leaves nothing behind once the message is sent", () => {
    const storage = new FakeStorage();
    const drafts = store(storage);
    type_(drafts, "ses_1", "sent in a moment");
    drafts.clear("ses_1");
    expect(text_(drafts, "ses_1")).toBe("");
    expect(drafts.keys()).toEqual([]);
    expect(storage.map.size).toBe(0);
  });

  it("treats an emptied composer as no draft", () => {
    const storage = new FakeStorage();
    const drafts = store(storage);
    type_(drafts, "ses_1", "typed");
    type_(drafts, "ses_1", "");
    expect(drafts.keys()).toEqual([]);
    expect(storage.map.size).toBe(0);
  });

  it("lists the sessions holding a draft", () => {
    const drafts = store(new FakeStorage());
    type_(drafts, "ses_1", "one");
    type_(drafts, "new", "two");
    expect(new Set(drafts.keys())).toEqual(new Set(["ses_1", "new"]));
  });

  it("notifies subscribers and hands out a fresh snapshot per change", () => {
    const drafts = store(new FakeStorage());
    let calls = 0;
    const stop = drafts.subscribe(() => {
      calls += 1;
    });
    const before = drafts.snapshot();
    type_(drafts, "ses_1", "x");
    expect(calls).toBe(1);
    expect(drafts.snapshot()).not.toBe(before);
    expect(drafts.snapshot().get("ses_1")?.text).toBe("x");
    // Re-typing the same text is not a change, so React does not re-render.
    type_(drafts, "ses_1", "x");
    expect(calls).toBe(1);
    stop();
    type_(drafts, "ses_1", "y");
    expect(calls).toBe(1);
  });

  it("coalesces writes and flushes on demand", () => {
    const storage = new FakeStorage();
    const drafts = new DraftStore({ scope: "/repo", storage, writeDelayMs: 5_000 });
    type_(drafts, "ses_1", "typing…");
    expect(storage.map.size).toBe(0);
    drafts.flush();
    expect(text_(store(storage), "ses_1")).toBe("typing…");
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
    type_(store(storage, { now: () => clock }), "ses_old", "last month");
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
    for (let i = 0; i < 5; i += 1) type_(writer, `ses_${i}`, `draft ${i}`);
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
    // `attachments` was the field this was written for, and it has since
    // arrived; the guarantee is what matters, so it now rides on the next
    // unknown field rather than being retired with the old one.
    const storage = new FakeStorage();
    const key = "daydream.draft.%2Frepo.ses_1";
    storage.setItem(
      key,
      JSON.stringify({ text: "look at this", at: 10, caretAt: 4 }),
    );
    const drafts = store(storage, { now: () => 20 });
    expect(text_(drafts, "ses_1")).toBe("look at this");
    type_(drafts, "ses_1", "look at this instead");
    const written: unknown = JSON.parse(storage.getItem(key) ?? "null");
    expect(written).toEqual({
      text: "look at this instead",
      at: 20,
      caretAt: 4,
    });
  });

  it("keeps attached images with the text they were pasted into", () => {
    const storage = new FakeStorage();
    const drafts = store(storage);
    type_(drafts, "ses_1", "what is wrong here?");
    drafts.attach("ses_1", shot("aa.png", "screen.png"));
    // A reload is a fresh store over the same storage.
    const draft = store(storage).get("ses_1");
    expect(draft.text).toBe("what is wrong here?");
    expect(draft.attachments).toEqual([shot("aa.png", "screen.png")]);
  });

  it("keeps an image-only draft, which has no text to remember it by", () => {
    const storage = new FakeStorage();
    const drafts = store(storage);
    drafts.attach("ses_1", shot("bb.png"));
    expect(store(storage).get("ses_1").attachments).toHaveLength(1);
    expect(draftPreview(store(storage).get("ses_1"))).toBe("1 image");
    drafts.detach("ses_1", "bb.png");
    // Nothing left: not the empty draft of a composer someone is looking at.
    expect(drafts.keys()).toEqual([]);
    expect(storage.map.size).toBe(0);
  });

  it("never attaches the same blob twice", () => {
    const drafts = store(new FakeStorage());
    drafts.attach("ses_1", shot("cc.png"));
    drafts.attach("ses_1", shot("cc.png"));
    expect(drafts.get("ses_1").attachments).toHaveLength(1);
  });

  it("writes a text-only draft exactly as the version before this one did", () => {
    const storage = new FakeStorage();
    const drafts = store(storage, { now: () => 7 });
    type_(drafts, "ses_1", "no images here");
    expect(
      JSON.parse(storage.getItem("daydream.draft.%2Frepo.ses_1") ?? "null"),
    ).toEqual({ text: "no images here", at: 7 });
  });

  it("drops persisted attachments that are not attachments", () => {
    const storage = new FakeStorage();
    storage.setItem(
      "daydream.draft.%2Frepo.ses_1",
      JSON.stringify({
        text: "hi",
        at: 5,
        attachments: [{ path: "shot.png" }, 4, null, shot("dd.png")],
      }),
    );
    // A hand-edited or older draft must cost the bad chips, not the paragraph.
    expect(store(storage, { now: () => 6 }).get("ses_1")).toEqual({
      text: "hi",
      attachments: [shot("dd.png")],
    });
  });

  it("keeps draft identity stable when another draft changes", () => {
    const drafts = store(new FakeStorage());
    type_(drafts, "ses_1", "one");
    const before = drafts.get("ses_1");
    type_(drafts, "ses_2", "two");
    // Identity is what useSyncExternalStore compares: an unrelated keystroke
    // must not re-render every rail row.
    expect(drafts.get("ses_1")).toBe(before);
  });

  it("works without any storage at all", () => {
    const drafts = new DraftStore({ scope: "/repo", storage: null });
    type_(drafts, "ses_1", "memory only");
    drafts.flush();
    expect(text_(drafts, "ses_1")).toBe("memory only");
  });
});

describe("draftPreview", () => {
  const draft = (text: string, attachments: Attachment[] = []): Draft => ({
    text,
    attachments,
  });

  it("shows the first line", () => {
    expect(draftPreview(draft("  first\nsecond  "))).toBe("first");
  });

  it("truncates long lines", () => {
    expect(draftPreview(draft("x".repeat(50)), 10)).toBe(`${"x".repeat(9)}…`);
  });

  it("is empty for empty text", () => {
    expect(draftPreview(draft("   "))).toBe("");
    expect(draftPreview(undefined)).toBe("");
  });

  it("says what is attached when there is nothing to quote", () => {
    expect(draftPreview(draft("", [shot("a.png"), shot("b.png")]))).toBe(
      "2 images",
    );
    // Text wins when there is any: it says more than a count does.
    expect(draftPreview(draft("look", [shot("a.png")]))).toBe("look");
  });
});
