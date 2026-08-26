import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { QuickActionRecord } from "@daydream-code/actions";
import {
  LEGACY_STORAGE_KEY,
  QuickActionStore,
  legacyActions,
  type ActionsApi,
  type StorageLike,
} from "../src/quick-actions.js";
import {
  commandLaunch,
  parseRequest,
  runQuickAction,
  terminalLaunch,
} from "../electron/quick-actions.js";

const NUL = "\u0000";

function memoryStorage(seed: Record<string, string> = {}): StorageLike & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

/** The project's list, as a fake core: the store is a cache over this. */
function fakeApi(seed: QuickActionRecord[] = []): ActionsApi & {
  rows: QuickActionRecord[];
  calls: string[];
} {
  const rows = [...seed];
  const calls: string[] = [];
  let n = 0;
  return {
    rows,
    calls,
    actions: () => {
      calls.push("list");
      return Promise.resolve([...rows]);
    },
    addAction: (input) => {
      calls.push(`add:${input.command}`);
      const record: QuickActionRecord = {
        id: `act_${(n += 1)}`,
        label: input.label ?? input.command,
        command: input.command,
        source: "you",
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      rows.push(record);
      return Promise.resolve(record);
    },
    updateAction: (id, patch) => {
      calls.push(`update:${id}`);
      const row = rows.find((r) => r.id === id);
      if (row === undefined) return Promise.reject(new Error("no such action"));
      Object.assign(row, patch);
      return Promise.resolve(row);
    },
    removeAction: (id) => {
      calls.push(`remove:${id}`);
      const at = rows.findIndex((r) => r.id === id);
      if (at >= 0) rows.splice(at, 1);
      return Promise.resolve({ ok: true } as const);
    },
  };
}

describe("QuickActionStore", () => {
  it("caches the project's list and hands out a new identity per change", async () => {
    const store = new QuickActionStore(fakeApi(), { storage: null });
    const seen = vi.fn();
    store.subscribe(seen);
    const before = store.snapshot();
    await store.refresh();
    await store.add({ command: "pnpm dev", label: "Dev" });
    expect(store.snapshot()).not.toBe(before);
    expect(store.snapshot().map((a) => a.command)).toEqual(["pnpm dev"]);
    expect(seen).toHaveBeenCalled();
  });

  it("re-reads after every write, since the list is not only this window's", async () => {
    // A session can add a row between two clicks here, so a write that patched
    // the local copy would quietly drop it.
    const api = fakeApi();
    const store = new QuickActionStore(api, { storage: null });
    const added = await store.add({ command: "pnpm dev" });
    api.rows.push({
      id: "act_agent",
      label: "Docs",
      command: "pnpm docs",
      source: "write-the-docs",
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    await store.remove(added.id);
    expect(store.snapshot().map((a) => a.command)).toEqual(["pnpm docs"]);
  });

  it("keeps the last good list when a read fails", async () => {
    const api = fakeApi([
      {
        id: "act_1",
        label: "Dev",
        command: "pnpm dev",
        source: "you",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const store = new QuickActionStore(api, { storage: null });
    await store.refresh();
    api.actions = () => Promise.reject(new Error("core is gone"));
    await expect(store.refresh()).rejects.toThrow("core is gone");
    expect(store.snapshot()).toHaveLength(1);
  });
});

describe("legacy adoption", () => {
  it("moves rows the renderer-local version stored into the project, once", async () => {
    const storage = memoryStorage({
      [LEGACY_STORAGE_KEY]: JSON.stringify([
        { id: "a", label: "Dev", command: "pnpm dev" },
        { id: "b", command: "pnpm test" },
      ]),
    });
    const api = fakeApi();
    const store = new QuickActionStore(api, { storage });
    await store.refresh();
    expect(api.rows.map((r) => [r.label, r.command])).toEqual([
      ["Dev", "pnpm dev"],
      ["pnpm test", "pnpm test"],
    ]);
    expect(storage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
    // Second pass must not re-add what the person may have since deleted.
    await store.refresh();
    expect(api.rows).toHaveLength(2);
  });

  it("leaves a project that already has actions alone", async () => {
    const storage = memoryStorage({
      [LEGACY_STORAGE_KEY]: JSON.stringify([{ command: "pnpm dev" }]),
    });
    const api = fakeApi([
      {
        id: "act_1",
        label: "Docs",
        command: "pnpm docs",
        source: "you",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    await new QuickActionStore(api, { storage }).refresh();
    expect(api.rows).toHaveLength(1);
    expect(storage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
  });

  it("drops junk rather than the whole legacy list", () => {
    expect(legacyActions("not json")).toEqual([]);
    expect(legacyActions(JSON.stringify({ command: "ls" }))).toEqual([]);
    expect(
      legacyActions(JSON.stringify([{ command: "  " }, 7, { command: "ls" }])),
    ).toEqual([{ command: "ls" }]);
  });
});

describe("parseRequest", () => {
  it("accepts the three shapes and nothing else", () => {
    expect(parseRequest({ kind: "reveal" })).toEqual({ kind: "reveal" });
    expect(parseRequest({ kind: "terminal" })).toEqual({ kind: "terminal" });
    expect(parseRequest({ kind: "command", command: " ls " })).toEqual({
      kind: "command",
      command: "ls",
    });
    expect(parseRequest({ kind: "open", path: "/etc" })).toBeNull();
    expect(parseRequest(null)).toBeNull();
    expect(parseRequest({ kind: "command" })).toBeNull();
    expect(parseRequest({ kind: "command", command: "" })).toBeNull();
    expect(parseRequest({ kind: "command", command: "x".repeat(5000) })).toBeNull();
    expect(parseRequest({ kind: "command", command: `ls${NUL}-l` })).toBeNull();
  });
});

describe("terminalLaunch", () => {
  it("opens the macOS terminal application at the root", () => {
    expect(terminalLaunch("/p", { platform: "darwin", env: {} })).toEqual({
      file: "open",
      args: ["-a", "Terminal", "/p"],
    });
  });

  it("honours DAYDREAM_TERMINAL on macOS", () => {
    expect(
      terminalLaunch("/p", { platform: "darwin", env: { DAYDREAM_TERMINAL: "iTerm" } }),
    ).toEqual({ file: "open", args: ["-a", "iTerm", "/p"] });
  });

  it("picks the first terminal actually installed on linux", () => {
    expect(
      terminalLaunch("/p", {
        platform: "linux",
        env: {},
        onPath: (file) => file === "konsole",
      }),
    ).toEqual({ file: "konsole", args: [] });
  });

  it("prefers DAYDREAM_TERMINAL over the built-in list on linux", () => {
    const launch = terminalLaunch("/p", {
      platform: "linux",
      env: { DAYDREAM_TERMINAL: "ghostty" },
      onPath: () => true,
    });
    expect(launch?.file).toBe("ghostty");
  });

  it("reports none rather than guessing when nothing is installed", () => {
    expect(
      terminalLaunch("/p", { platform: "linux", env: {}, onPath: () => false }),
    ).toBeNull();
  });
});

describe("commandLaunch", () => {
  it("runs through the login shell so PATH is the one the person has", () => {
    expect(
      commandLaunch("code .", { platform: "darwin", env: { SHELL: "/bin/zsh" } }),
    ).toEqual({ file: "/bin/zsh", args: ["-lc", "code ."] });
  });

  it("falls back to /bin/sh when the environment names no shell", () => {
    expect(commandLaunch("ls", { platform: "linux", env: {} }).file).toBe("/bin/sh");
  });

  it("uses cmd on windows", () => {
    expect(commandLaunch("dir", { platform: "win32", env: {} })).toEqual({
      file: "cmd.exe",
      args: ["/d", "/s", "/c", "dir"],
    });
  });
});

/** A child process that can be told how to end, without spawning anything. */
interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  unref: () => void;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = vi.fn();
  return child;
}

describe("runQuickAction", () => {
  const base = {
    platform: "darwin" as NodeJS.Platform,
    env: { SHELL: "/bin/zsh" } as NodeJS.ProcessEnv,
    openPath: () => Promise.resolve(""),
    graceMs: 20,
  };

  it("reveals through the shell and reports the OS's complaint", async () => {
    await expect(
      runQuickAction({ kind: "reveal" }, "/p", {
        ...base,
        spawn: vi.fn() as never,
        openPath: () => Promise.resolve("no such folder"),
      }),
    ).resolves.toEqual({ ok: false, error: "no such folder" });
  });

  it("refuses a request that is not one, rather than running something", async () => {
    const spawn = vi.fn();
    await expect(
      runQuickAction({ kind: "command", command: "" }, "/p", {
        ...base,
        spawn: spawn as never,
      }),
    ).resolves.toEqual({ ok: false, error: "invalid quick action" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("runs a command at the project root", async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const result = runQuickAction({ kind: "command", command: "ls" }, "/p", {
      ...base,
      spawn: spawn as never,
    });
    child.emit("exit", 0, null);
    await expect(result).resolves.toEqual({ ok: true });
    expect(spawn).toHaveBeenCalledWith(
      "/bin/zsh",
      ["-lc", "ls"],
      expect.objectContaining({ cwd: "/p" }),
    );
  });

  // The reason it watches the child at all: fire-and-forget would report
  // success for a typo and leave the person staring at a window where nothing
  // happened.
  it("reports the failure of a command that exits badly", async () => {
    const child = fakeChild();
    const result = runQuickAction({ kind: "command", command: "cdoe ." }, "/p", {
      ...base,
      spawn: (() => child) as never,
    });
    child.stderr.emit("data", "zsh: command not found: cdoe\n");
    child.emit("exit", 127, null);
    await expect(result).resolves.toEqual({
      ok: false,
      error: "zsh: command not found: cdoe",
    });
  });

  it("releases a command still running after the grace window", async () => {
    const child = fakeChild();
    const result = await runQuickAction({ kind: "command", command: "pnpm dev" }, "/p", {
      ...base,
      spawn: (() => child) as never,
    });
    expect(result).toEqual({ ok: true, detail: "still running" });
    expect(child.unref).toHaveBeenCalled();
  });

  it("reports a spawn error instead of hanging", async () => {
    const child = fakeChild();
    const result = runQuickAction({ kind: "terminal" }, "/p", {
      ...base,
      spawn: (() => child) as never,
    });
    child.emit("error", new Error("spawn open ENOENT"));
    await expect(result).resolves.toEqual({ ok: false, error: "spawn open ENOENT" });
  });
});
