import { describe, expect, it, vi } from "vitest";
import { nextTerminalId, terminalLabel } from "../src/terminal.js";
import {
  MAX_HISTORY_BYTES,
  MAX_TERMINAL_ID,
  MAX_WRITE_BYTES,
  TerminalSessions,
  isMissingBinary,
  parseAttachmentRequest,
  parseOpenRequest,
  parseResizeRequest,
  parseTerminalId,
  parseWriteRequest,
  sanitizeReplay,
  shellCandidates,
  spawnHelperCandidates,
  terminalEnv,
  trimHistory,
  type PtyProcess,
  type PtySpawnOptions,
  type TerminalDeps,
  type TerminalEvent,
} from "../electron/terminal.js";

const ESC = "\u001b";
const BEL = "\u0007";
const ST = "\u001b\\";

// --------------------------------------------------------------------------
// A pty we can drive from the test.

interface FakePty extends PtyProcess {
  emit(data: string): void;
  exit(code: number, signal?: number): void;
  readonly writes: string[];
  readonly sizes: Array<[number, number]>;
  readonly signals: string[];
}

function fakePty(pid = 4242): FakePty {
  let onData: (data: string) => void = () => undefined;
  let onExit: (event: { exitCode: number; signal?: number }) => void = () => undefined;
  const writes: string[] = [];
  const sizes: Array<[number, number]> = [];
  const signals: string[] = [];
  return {
    pid,
    writes,
    sizes,
    signals,
    write: (data) => void writes.push(data),
    resize: (cols, rows) => void sizes.push([cols, rows]),
    kill: (signal) => void signals.push(signal ?? "SIGTERM"),
    onData: (listener) => void (onData = listener),
    onExit: (listener) => void (onExit = listener),
    emit: (data) => onData(data),
    exit: (exitCode, signal) => onExit({ exitCode, ...(signal === undefined ? {} : { signal }) }),
  };
}

function harness(
  overrides: Partial<TerminalDeps> = {},
): { deps: TerminalDeps; ptys: FakePty[]; spawns: Array<[string, readonly string[], PtySpawnOptions]> } {
  const ptys: FakePty[] = [];
  const spawns: Array<[string, readonly string[], PtySpawnOptions]> = [];
  const deps: TerminalDeps = {
    platform: "darwin",
    env: { SHELL: "/bin/zsh", PATH: "/usr/bin" },
    isDirectory: () => true,
    flushMs: 0,
    killGraceMs: 5,
    spawn: (file, args, options) => {
      spawns.push([file, args, options]);
      const pty = fakePty(1000 + ptys.length);
      ptys.push(pty);
      return pty;
    },
    ...overrides,
  };
  return { deps, ptys, spawns };
}

const ROOT = "/repo";
const openReq = {
  terminalId: "term-1",
  attachmentId: "mount-1",
  cols: 80,
  rows: 24,
};

// --------------------------------------------------------------------------

describe("request parsing", () => {
  it("accepts well-formed ids and rejects the rest", () => {
    expect(parseTerminalId("term-1")).toBe("term-1");
    expect(parseTerminalId("  term-2  ")).toBe("term-2");
    expect(parseTerminalId("")).toBeNull();
    expect(parseTerminalId("../etc/passwd")).toBeNull();
    expect(parseTerminalId("-leading")).toBeNull();
    expect(parseTerminalId("a".repeat(MAX_TERMINAL_ID + 1))).toBeNull();
    expect(parseTerminalId(42)).toBeNull();
    expect(parseTerminalId(null)).toBeNull();
  });

  it("bounds terminal dimensions", () => {
    expect(
      parseOpenRequest({ terminalId: "t", attachmentId: "mount-1", cols: 80, rows: 24 }),
    ).toEqual({
      terminalId: "t",
      attachmentId: "mount-1",
      cols: 80,
      rows: 24,
    });
    expect(parseAttachmentRequest({ terminalId: "t", attachmentId: "mount-1" })).toEqual({
      terminalId: "t",
      attachmentId: "mount-1",
    });
    expect(parseAttachmentRequest({ terminalId: "t", attachmentId: "../old" })).toBeNull();
    expect(
      parseOpenRequest({ terminalId: "t", attachmentId: "mount-1", cols: 0, rows: 24 }),
    ).toBeNull();
    expect(
      parseOpenRequest({
        terminalId: "t",
        attachmentId: "mount-1",
        cols: 80,
        rows: 100_000,
      }),
    ).toBeNull();
    expect(
      parseOpenRequest({ terminalId: "t", attachmentId: "mount-1", cols: 80.5, rows: 24 }),
    ).toBeNull();
    expect(parseOpenRequest({ terminalId: "t" })).toBeNull();
    expect(parseOpenRequest(null)).toBeNull();
    expect(parseResizeRequest({ terminalId: "t", cols: 120, rows: 40 })).toEqual({
      terminalId: "t",
      cols: 120,
      rows: 40,
    });
  });

  it("bounds writes", () => {
    expect(parseWriteRequest({ terminalId: "t", data: "ls\r" })).toEqual({
      terminalId: "t",
      data: "ls\r",
    });
    expect(parseWriteRequest({ terminalId: "t", data: "" })).toBeNull();
    expect(parseWriteRequest({ terminalId: "t", data: "x".repeat(MAX_WRITE_BYTES + 1) })).toBeNull();
    expect(parseWriteRequest({ terminalId: "t", data: 5 })).toBeNull();
  });
});

describe("environment", () => {
  it("strips what a child must not inherit and keeps everything else", () => {
    const env = terminalEnv({
      PATH: "/usr/local/bin:/usr/bin",
      HOME: "/Users/x",
      // The documented leak: a child inheriting this runs electron as bare node.
      ELECTRON_RUN_AS_NODE: "1",
      ELECTRON_RENDERER_URL: "http://localhost:5173",
      NODE_OPTIONS: "--inspect",
      PORT: "5173",
      DAYDREAM_SMOKE: "/tmp/x",
      VITE_FOO: "bar",
      HTTPS_PROXY: "http://proxy:8080",
      NVM_DIR: "/Users/x/.nvm",
    });
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.ELECTRON_RENDERER_URL).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.PORT).toBeUndefined();
    expect(env.DAYDREAM_SMOKE).toBeUndefined();
    expect(env.VITE_FOO).toBeUndefined();
    // A blocklist, not an allowlist: these must survive.
    expect(env.PATH).toBe("/usr/local/bin:/usr/bin");
    expect(env.HTTPS_PROXY).toBe("http://proxy:8080");
    expect(env.NVM_DIR).toBe("/Users/x/.nvm");
    expect(env.TERM).toBe("xterm-256color");
    expect(env.COLORTERM).toBe("truecolor");
  });
});

describe("shell selection", () => {
  it("prefers $SHELL as a login shell, then falls back", () => {
    const candidates = shellCandidates({ platform: "darwin", env: { SHELL: "/opt/fish" } });
    expect(candidates[0]).toEqual({ file: "/opt/fish", args: ["-l"] });
    expect(candidates.map((c) => c.file)).toEqual([
      "/opt/fish",
      "/bin/zsh",
      "/bin/bash",
      "/bin/sh",
    ]);
  });

  it("does not list $SHELL twice when it is already a fallback", () => {
    const files = shellCandidates({ platform: "darwin", env: { SHELL: "/bin/zsh" } }).map(
      (c) => c.file,
    );
    expect(files).toEqual([...new Set(files)]);
  });

  it("uses PowerShell on Windows", () => {
    const candidates = shellCandidates({ platform: "win32", env: { ComSpec: "C:\\cmd.exe" } });
    expect(candidates[0]).toEqual({ file: "pwsh.exe", args: ["-NoLogo"] });
    expect(candidates.map((c) => c.file)).toContain("C:\\cmd.exe");
  });

  it("only treats a missing binary as a reason to try the next shell", () => {
    expect(isMissingBinary(new Error("posix_spawnp failed."))).toBe(true);
    expect(isMissingBinary(new Error("ENOENT: no such file or directory"))).toBe(true);
    // A real fault must not be papered over by silently running another shell.
    expect(isMissingBinary(new Error("EACCES: permission denied"))).toBe(false);
    expect(isMissingBinary(new Error("out of memory"))).toBe(false);
  });
});

describe("spawn-helper resolution", () => {
  it("looks in the build dir before the prebuild, and nowhere on Windows", () => {
    expect(spawnHelperCandidates("/pkg/node-pty", "darwin", "arm64")).toEqual([
      "/pkg/node-pty/build/Release/spawn-helper",
      "/pkg/node-pty/build/Debug/spawn-helper",
      "/pkg/node-pty/prebuilds/darwin-arm64/spawn-helper",
    ]);
    expect(spawnHelperCandidates("/pkg/node-pty", "win32", "x64")).toEqual([]);
  });
});

describe("replay sanitising", () => {
  it("keeps ordinary output and styling untouched", () => {
    const styled = `${ESC}[1;32mhello${ESC}[0m\r\n$ `;
    expect(sanitizeReplay(styled)).toBe(styled);
  });

  it("drops the queries that would be answered a second time", () => {
    // Device Status Report and its Cursor Position Report reply.
    expect(sanitizeReplay(`a${ESC}[6nb`)).toBe("ab");
    expect(sanitizeReplay(`a${ESC}[24;80Rb`)).toBe("ab");
    // Primary and secondary Device Attributes.
    expect(sanitizeReplay(`a${ESC}[cb`)).toBe("ab");
    expect(sanitizeReplay(`a${ESC}[>0cb`)).toBe("ab");
    // XTVERSION.
    expect(sanitizeReplay(`a${ESC}[>0qb`)).toBe("ab");
    // DECRQM.
    expect(sanitizeReplay(`a${ESC}[?2026$pb`)).toBe("ab");
    // The Kitty keyboard protocol query.
    expect(sanitizeReplay(`a${ESC}[?ub`)).toBe("ab");
  });

  it("keeps the sequences that only set state", () => {
    // Soft reset, DECSCL and the cursor-shape select all end in p/q/u too, and
    // stripping them would change the terminal the replay arrives at.
    for (const keep of [`${ESC}[!p`, `${ESC}[61"p`, `${ESC}[2 q`, `${ESC}[=1u`, `${ESC}[<1u`]) {
      expect(sanitizeReplay(`a${keep}b`)).toBe(`a${keep}b`);
    }
  });

  it("drops colour queries but keeps colour assignments", () => {
    expect(sanitizeReplay(`a${ESC}]11;?${BEL}b`)).toBe("ab");
    expect(sanitizeReplay(`a${ESC}]10;rgb:ffff/ffff/ffff${ST}b`)).toBe("ab");
    const setTitle = `${ESC}]0;my title${BEL}`;
    expect(sanitizeReplay(`a${setTitle}b`)).toBe(`a${setTitle}b`);
    const setColour = `${ESC}]11;#1e1e1e${BEL}`;
    expect(sanitizeReplay(`a${setColour}b`)).toBe(`a${setColour}b`);
  });

  it("drops DECRQSS and XTGETTCAP but keeps other DCS payloads", () => {
    expect(sanitizeReplay(`a${ESC}P$qm${ST}b`)).toBe("ab");
    expect(sanitizeReplay(`a${ESC}P+q544e${ST}b`)).toBe("ab");
    const sixel = `${ESC}Pq#0;2;0;0;0${ST}`;
    expect(sanitizeReplay(`a${sixel}b`)).toBe(`a${sixel}b`);
  });

  it("does not emit a half-parsed sequence from a truncated tail", () => {
    // History is trimmed at a line boundary, but a cut can still land mid-escape.
    expect(sanitizeReplay(`done\r\n${ESC}[6`)).toBe("done\r\n");
    expect(sanitizeReplay(`done\r\n${ESC}]11;`)).toBe("done\r\n");
  });
});

describe("history trimming", () => {
  it("keeps short history verbatim", () => {
    expect(trimHistory("hello", 100)).toBe("hello");
  });

  it("cuts at a line boundary so a replay never starts mid-escape", () => {
    const history = `${"x".repeat(50)}\nSECOND LINE\n${"y".repeat(20)}`;
    const trimmed = trimHistory(history, 40);
    expect(trimmed.startsWith("SECOND LINE") || trimmed.startsWith("y")).toBe(true);
    expect(history.endsWith(trimmed)).toBe(true);
  });

  it("has a cap large enough to be worth calling scrollback", () => {
    expect(MAX_HISTORY_BYTES).toBeGreaterThanOrEqual(64 * 1024);
  });
});

// --------------------------------------------------------------------------

describe("sessions", () => {
  const collect = (): { events: TerminalEvent[]; listener: (e: TerminalEvent) => void } => {
    const events: TerminalEvent[] = [];
    return { events, listener: (event) => void events.push(event) };
  };

  it("spawns at the project root with a sanitised env", () => {
    const { deps, spawns } = harness({
      env: { SHELL: "/bin/zsh", ELECTRON_RUN_AS_NODE: "1", PATH: "/usr/bin" },
    });
    const sessions = new TerminalSessions(deps);
    const opened = sessions.open(openReq, ROOT, collect().listener);
    expect(opened.ok).toBe(true);
    const [file, args, options] = spawns[0]!;
    expect(file).toBe("/bin/zsh");
    expect(args).toEqual(["-l"]);
    expect(options.cwd).toBe(ROOT);
    expect(options.cols).toBe(80);
    expect(options.name).toBe("xterm-256color");
    expect(options.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    sessions.disposeAll();
  });

  it("refuses a root that is not a directory", () => {
    const { deps } = harness({ isDirectory: () => false });
    const sessions = new TerminalSessions(deps);
    const opened = sessions.open(openReq, ROOT, collect().listener);
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.error).toContain("not a directory");
  });

  it("falls through to the next shell only when the binary is missing", () => {
    let attempt = 0;
    const { deps, spawns } = harness({
      spawn: (file, args, options) => {
        attempt += 1;
        if (attempt === 1) throw new Error("posix_spawnp failed.");
        spawns.push([file, args, options]);
        return fakePty();
      },
    });
    const sessions = new TerminalSessions(deps);
    expect(sessions.open(openReq, ROOT, collect().listener).ok).toBe(true);
    // $SHELL threw ENOENT, so the terminal opened on the next candidate rather
    // than failing — only successful spawns are recorded.
    expect(attempt).toBe(2);
    expect(spawns[0]![0]).toBe("/bin/bash");
    sessions.disposeAll();
  });

  it("reports a non-ENOENT spawn failure instead of running a different shell", () => {
    const { deps } = harness({
      spawn: () => {
        throw new Error("EACCES: permission denied");
      },
    });
    const sessions = new TerminalSessions(deps);
    const opened = sessions.open(openReq, ROOT, collect().listener);
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.error).toContain("permission denied");
  });

  it("adopts a running terminal rather than replacing it", () => {
    const { deps, ptys, spawns } = harness();
    const sessions = new TerminalSessions(deps);
    sessions.open(openReq, ROOT, collect().listener);
    ptys[0]!.emit("first run\r\n");

    const second = collect();
    const reopened = sessions.open(openReq, ROOT, second.listener);
    expect(spawns).toHaveLength(1);
    expect(reopened.ok).toBe(true);
    if (reopened.ok) expect(reopened.value.snapshot.history).toContain("first run");
    sessions.disposeAll();
  });

  it("keeps terminals of the same id in different projects apart", () => {
    const { deps, ptys, spawns } = harness();
    const sessions = new TerminalSessions(deps);
    sessions.open(openReq, "/repo-a", collect().listener);
    sessions.open(openReq, "/repo-b", collect().listener);
    expect(spawns).toHaveLength(2);
    ptys[0]!.emit("A");
    const b = sessions.open(openReq, "/repo-b", collect().listener);
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.value.snapshot.history).toBe("");
    expect(sessions.list("/repo-a")).toEqual(["term-1"]);
    sessions.disposeAll();
  });

  it("replays scrollback to a client that attaches later", () => {
    const { deps, ptys } = harness();
    const sessions = new TerminalSessions(deps);
    const first = collect();
    const opened = sessions.open(openReq, ROOT, first.listener);
    if (!opened.ok) throw new Error("open failed");
    // The view unmounts — a project switch remounts the whole workspace.
    opened.value.detach();
    ptys[0]!.emit("work happened while hidden\r\n");

    const second = collect();
    const again = sessions.open(openReq, ROOT, second.listener);
    if (!again.ok) throw new Error("reopen failed");
    expect(again.value.snapshot.history).toContain("work happened while hidden");
    expect(again.value.snapshot.status).toBe("running");
    sessions.disposeAll();
  });

  it("strips queries from the replayed history, not from the live stream", async () => {
    const { deps, ptys } = harness();
    const sessions = new TerminalSessions(deps);
    const live = collect();
    const opened = sessions.open(openReq, ROOT, live.listener);
    if (!opened.ok) throw new Error("open failed");
    ptys[0]!.emit(`prompt${ESC}[6n`);
    await vi.waitFor(() => expect(live.events.length).toBeGreaterThan(0));
    // Live output is passed through verbatim: the emulator should answer a
    // query that is genuinely being asked right now.
    expect(live.events[0]).toMatchObject({ type: "output", data: `prompt${ESC}[6n` });

    const replayed = sessions.open(openReq, ROOT, collect().listener);
    if (!replayed.ok) throw new Error("reopen failed");
    expect(replayed.value.snapshot.history).toBe("prompt");
    sessions.disposeAll();
  });

  it("coalesces a burst of output into one message", async () => {
    const { deps, ptys } = harness({ flushMs: 5 });
    const sessions = new TerminalSessions(deps);
    const seen = collect();
    sessions.open(openReq, ROOT, seen.listener);
    for (const chunk of ["a", "b", "c", "d"]) ptys[0]!.emit(chunk);
    await vi.waitFor(() => expect(seen.events).toHaveLength(1));
    expect(seen.events[0]).toMatchObject({ type: "output", data: "abcd" });
    sessions.disposeAll();
  });

  it("numbers events so a client can tell replay from live", async () => {
    const { deps, ptys } = harness();
    const sessions = new TerminalSessions(deps);
    const seen = collect();
    const opened = sessions.open(openReq, ROOT, seen.listener);
    if (!opened.ok) throw new Error("open failed");
    expect(opened.value.snapshot.sequence).toBe(0);
    ptys[0]!.emit("one");
    await vi.waitFor(() => expect(seen.events).toHaveLength(1));
    expect(seen.events[0]!.sequence).toBe(1);
  });

  it("passes keystrokes through and forwards resizes", () => {
    const { deps, ptys } = harness();
    const sessions = new TerminalSessions(deps);
    sessions.open(openReq, ROOT, collect().listener);
    expect(sessions.write({ terminalId: "term-1", data: "ls\r" }, ROOT).ok).toBe(true);
    expect(ptys[0]!.writes).toEqual(["ls\r"]);
    sessions.resize({ terminalId: "term-1", cols: 120, rows: 40 }, ROOT);
    expect(ptys[0]!.sizes).toEqual([[120, 40]]);
    // An identical resize is not worth a syscall or a prompt reprint.
    sessions.resize({ terminalId: "term-1", cols: 120, rows: 40 }, ROOT);
    expect(ptys[0]!.sizes).toHaveLength(1);
    sessions.disposeAll();
  });

  it("reports an exit once, with its code", async () => {
    const { deps, ptys } = harness();
    const sessions = new TerminalSessions(deps);
    const seen = collect();
    sessions.open(openReq, ROOT, seen.listener);
    ptys[0]!.exit(3);
    await vi.waitFor(() => expect(seen.events.some((e) => e.type === "exit")).toBe(true));
    const exits = seen.events.filter((e) => e.type === "exit");
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({ exitCode: 3, signal: null });
  });

  it("flushes buffered output before announcing the exit", async () => {
    const { deps, ptys } = harness({ flushMs: 50 });
    const sessions = new TerminalSessions(deps);
    const seen = collect();
    sessions.open(openReq, ROOT, seen.listener);
    // A shell that prints and immediately exits must not lose its last line.
    ptys[0]!.emit("goodbye\r\n");
    ptys[0]!.exit(0);
    await vi.waitFor(() => expect(seen.events.some((e) => e.type === "exit")).toBe(true));
    expect(seen.events[0]).toMatchObject({ type: "output", data: "goodbye\r\n" });
    expect(seen.events[1]!.type).toBe("exit");
  });

  it("treats a keystroke after the shell exits as a no-op, not an error", async () => {
    const { deps, ptys } = harness();
    const sessions = new TerminalSessions(deps);
    sessions.open(openReq, ROOT, collect().listener);
    ptys[0]!.exit(0);
    const written = sessions.write({ terminalId: "term-1", data: "x" }, ROOT);
    expect(written.ok).toBe(true);
    expect(ptys[0]!.writes).toEqual([]);
  });

  it("treats a resize after close as a no-op", () => {
    const { deps } = harness();
    const sessions = new TerminalSessions(deps);
    sessions.open(openReq, ROOT, collect().listener);
    sessions.close("term-1", ROOT);
    // A ResizeObserver can already have queued this when the view went away.
    expect(sessions.resize({ terminalId: "term-1", cols: 10, rows: 10 }, ROOT).ok).toBe(true);
  });

  it("refuses to write to a terminal that was never opened", () => {
    const { deps } = harness();
    const sessions = new TerminalSessions(deps);
    expect(sessions.write({ terminalId: "ghost", data: "x" }, ROOT).ok).toBe(false);
  });

  it("escalates SIGTERM to SIGKILL, and stops if the shell goes first", async () => {
    const { deps, ptys } = harness({ killGraceMs: 5 });
    const sessions = new TerminalSessions(deps);
    sessions.open(openReq, ROOT, collect().listener);
    sessions.close("term-1", ROOT);
    expect(ptys[0]!.signals).toEqual(["SIGTERM"]);
    await vi.waitFor(() => expect(ptys[0]!.signals).toEqual(["SIGTERM", "SIGKILL"]));

    const second = new TerminalSessions(deps);
    second.open(openReq, ROOT, collect().listener);
    second.close("term-1", ROOT);
    ptys[1]!.exit(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The pty reaped itself inside the grace window, so nothing to escalate to.
    expect(ptys[1]!.signals).toEqual(["SIGTERM"]);
  });

  it("stops delivering output to a view that has closed the terminal", () => {
    const { deps, ptys } = harness();
    const sessions = new TerminalSessions(deps);
    const seen = collect();
    sessions.open(openReq, ROOT, seen.listener);
    sessions.close("term-1", ROOT);
    ptys[0]!.emit("output after close");
    expect(seen.events).toHaveLength(0);
  });

  it("forgets scrollback on close so a reopened terminal is fresh", () => {
    const { deps, ptys, spawns } = harness();
    const sessions = new TerminalSessions(deps);
    sessions.open(openReq, ROOT, collect().listener);
    ptys[0]!.emit("old output");
    sessions.close("term-1", ROOT);
    const reopened = sessions.open(openReq, ROOT, collect().listener);
    expect(spawns).toHaveLength(2);
    if (reopened.ok) expect(reopened.value.snapshot.history).toBe("");
    sessions.disposeAll();
  });

  it("kills every terminal on dispose", () => {
    const { deps, ptys } = harness();
    const sessions = new TerminalSessions(deps);
    sessions.open(openReq, ROOT, collect().listener);
    sessions.open({ ...openReq, terminalId: "term-2" }, ROOT, collect().listener);
    sessions.open(openReq, "/other", collect().listener);
    sessions.disposeAll();
    expect(ptys.map((p) => p.signals)).toEqual([["SIGTERM"], ["SIGTERM"], ["SIGTERM"]]);
    expect(sessions.list(ROOT)).toEqual([]);
  });
});

describe("terminal ids", () => {
  it("fills the lowest free slot rather than counting up forever", () => {
    expect(nextTerminalId([])).toBe("term-1");
    expect(nextTerminalId(["term-1"])).toBe("term-2");
    // Closing the middle tab should reuse its number, not leave a hole.
    expect(nextTerminalId(["term-1", "term-3"])).toBe("term-2");
    expect(nextTerminalId(["term-2", "term-1", "term-3"])).toBe("term-4");
  });

  it("never reuses an id that is still open", () => {
    const open = ["term-1", "term-2", "term-3"];
    expect(open).not.toContain(nextTerminalId(open));
  });

  it("labels tabs as prose, and leaves anything unexpected alone", () => {
    expect(terminalLabel("term-1")).toBe("Terminal 1");
    expect(terminalLabel("term-12")).toBe("Terminal 12");
    expect(terminalLabel("scratch")).toBe("scratch");
  });
});
