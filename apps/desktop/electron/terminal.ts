/**
 * Integrated terminals: real PTYs, owned by main, addressed by the open project.
 *
 * This lives beside `quick-actions.ts` for the same reason and with the same
 * shape — a renderer has no shell, and the project root must come from the
 * supervisor rather than from the wire, so a request carries a terminal id but
 * never a path.
 *
 * The scrollback lives *here*, not in the renderer. `App.tsx` keys
 * `HarnessProvider` on the connection, so switching projects unmounts the whole
 * workspace subtree; a terminal that kept its history in xterm's buffer would
 * come back blank every time. Main outlives that remount, so attach replays.
 *
 * Electron is injected rather than imported so this file is testable under
 * plain node — the same reason `registry.ts` and `stats.ts` stay importable.
 */

/** The slice of node-pty's IPty we depend on, so tests can hand us a fake. */
export interface PtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
}

export interface PtySpawnOptions {
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
  name: string;
}

export interface TerminalDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  spawn(file: string, args: readonly string[], options: PtySpawnOptions): PtyProcess;
  /** Injected so a test needs no real directory. */
  isDirectory(path: string): boolean;
  /** How long a shell gets to leave on SIGTERM before SIGKILL. */
  killGraceMs?: number;
  /** Output is coalesced over this window before it crosses the IPC boundary. */
  flushMs?: number;
}

export interface TerminalSnapshot {
  terminalId: string;
  pid: number;
  cols: number;
  rows: number;
  /** Replayable scrollback: already stripped of sequences that would reply. */
  history: string;
  /** Events at or below this were folded into `history`. */
  sequence: number;
  status: "running" | "exited";
}

export type TerminalEvent =
  | { type: "output"; terminalId: string; sequence: number; data: string }
  | {
      type: "exit";
      terminalId: string;
      sequence: number;
      exitCode: number;
      signal: number | null;
    };

export type TerminalResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface TerminalOpenRequest {
  terminalId: string;
  cols: number;
  rows: number;
}

export interface TerminalWriteRequest {
  terminalId: string;
  data: string;
}

export interface TerminalResizeRequest {
  terminalId: string;
  cols: number;
  rows: number;
}

/** Bounds are enforced here because this is where untrusted input lands. */
export const MAX_TERMINAL_ID = 64;
export const MAX_WRITE_BYTES = 65_536;
export const MAX_COLS = 1000;
export const MAX_ROWS = 500;
/** Roughly a screenful per 2 KB, so this is ~128 screens of scrollback. */
export const MAX_HISTORY_BYTES = 256 * 1024;

const DEFAULT_KILL_GRACE_MS = 1000;
const DEFAULT_FLUSH_MS = 8;

/**
 * Variables a child must not inherit from an Electron main process.
 *
 * A blocklist, not an allowlist: a terminal that quietly dropped `PATH`
 * additions, proxies, or a version manager's hooks would be subtly wrong in a
 * way nobody could debug from the prompt. Only what we know we broke is removed.
 *
 * `ELECTRON_RUN_AS_NODE` is the load-bearing entry. It is set whenever this app
 * is launched through a node-shaped entry point, and a child that inherits it
 * turns any `electron` the user runs into a bare node — a failure this repo has
 * already been bitten by once.
 */
const ENV_BLOCKLIST = new Set([
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_RENDERER_URL",
  "NODE_OPTIONS",
  "PORT",
]);

/** Prefixes owned by this app or its bundler; leaking them confuses child tools. */
const ENV_BLOCKED_PREFIXES = ["DAYDREAM_", "VITE_"];

export function terminalEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (ENV_BLOCKLIST.has(key.toUpperCase())) continue;
    if (ENV_BLOCKED_PREFIXES.some((prefix) => key.toUpperCase().startsWith(prefix))) {
      continue;
    }
    out[key] = value;
  }
  // The emulator on the other end is xterm.js, so claim what it implements
  // rather than inheriting whatever TERM the launching context happened to set
  // (launchd sets none at all, which leaves ncurses programs in dumb mode).
  out.TERM = "xterm-256color";
  out.COLORTERM = "truecolor";
  out.TERM_PROGRAM = "daydream-code";
  return out;
}

export interface ShellLaunch {
  file: string;
  args: string[];
}

/**
 * Shells to try, most preferred first.
 *
 * A list rather than one answer because `$SHELL` can name something that is not
 * installed in this context, and a terminal that fails to open is worse than one
 * that opens in bash.
 */
export function shellCandidates(
  deps: Pick<TerminalDeps, "platform" | "env">,
): ShellLaunch[] {
  if (deps.platform === "win32") {
    const comSpec = deps.env.ComSpec;
    return [
      { file: "pwsh.exe", args: ["-NoLogo"] },
      { file: "powershell.exe", args: ["-NoLogo"] },
      ...(comSpec !== undefined && comSpec.length > 0 ? [{ file: comSpec, args: [] }] : []),
      { file: "cmd.exe", args: [] },
    ];
  }
  const preferred = deps.env.SHELL;
  const ordered = [
    ...(preferred !== undefined && preferred.length > 0 ? [preferred] : []),
    "/bin/zsh",
    "/bin/bash",
    "/bin/sh",
  ];
  // A *login* shell, matching what Terminal.app gives you and for the reason
  // `quick-actions.ts` documents: a GUI process on macOS inherits launchd's
  // PATH, which has no `code`, no `pnpm` and no version manager in it. The
  // person's dotfiles are the only thing that puts them back.
  return dedupe(ordered).map((file) => ({ file, args: ["-l"] }));
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Did this spawn fail because the binary is not there?
 *
 * Only a missing shell justifies falling through to the next candidate. Any
 * other failure means the shell exists and something else is wrong, and silently
 * running a *different* shell would hide it.
 */
export function isMissingBinary(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("posix_spawnp failed") ||
    message.includes("enoent") ||
    message.includes("not found") ||
    message.includes("no such file")
  );
}

/**
 * Where node-pty keeps the macOS `spawn-helper`, most likely first.
 *
 * Pure so the resolution is testable; the `chmod` itself belongs to the caller,
 * which is the side that has a filesystem.
 */
export function spawnHelperCandidates(
  packageDir: string,
  platform: NodeJS.Platform,
  arch: string,
): string[] {
  if (platform === "win32") return [];
  const sep = packageDir.endsWith("/") ? "" : "/";
  return [
    `${packageDir}${sep}build/Release/spawn-helper`,
    `${packageDir}${sep}build/Debug/spawn-helper`,
    `${packageDir}${sep}prebuilds/${platform}-${arch}/spawn-helper`,
  ];
}

// ---------------------------------------------------------------------------
// Replay sanitising

/**
 * Remove sequences that ask the terminal a *question*.
 *
 * Scrollback is replayed into a fresh emulator on attach. Any query still in it
 * gets answered a second time, and those answers arrive at the shell as if the
 * user had typed them — so a restored terminal greets you with `^[[?62;c` and
 * friends smeared across the prompt. Replies already captured in the history are
 * dropped for the same reason: they are input the shell has consumed once.
 *
 * Sequences that *set* state are deliberately kept, because the point of the
 * replay is to arrive at the state the terminal was in.
 */
const ESC = "\u001b";
const BEL = "\u0007";
/** String Terminator, in its two-byte form. */
const ST = "\u001b\\";

export function sanitizeReplay(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const esc = text.indexOf(ESC, index);
    if (esc === -1) {
      out += text.slice(index);
      break;
    }
    out += text.slice(index, esc);
    const next = text[esc + 1];

    if (next === "[") {
      // CSI: parameter bytes 0x30-0x3f, intermediates 0x20-0x2f, final 0x40-0x7e.
      let at = esc + 2;
      while (at < text.length && text.charCodeAt(at) >= 0x30 && text.charCodeAt(at) <= 0x3f) {
        at += 1;
      }
      const params = text.slice(esc + 2, at);
      const intermediateStart = at;
      while (at < text.length && text.charCodeAt(at) >= 0x20 && text.charCodeAt(at) <= 0x2f) {
        at += 1;
      }
      const intermediates = text.slice(intermediateStart, at);
      const final = text[at];
      if (final === undefined) break; // truncated tail: drop it rather than emit a partial
      const sequence = text.slice(esc, at + 1);
      index = at + 1;
      if (!isCsiQuery(params, intermediates, final)) out += sequence;
      continue;
    }

    if (next === "]") {
      // OSC, terminated by BEL or ST.
      const bel = text.indexOf(BEL, esc + 2);
      const st = text.indexOf(ST, esc + 2);
      const end = pickTerminator(bel, st);
      if (end === -1) break;
      const body = text.slice(esc + 2, end.at);
      const sequence = text.slice(esc, end.at + end.width);
      index = end.at + end.width;
      // 10/11/12 are foreground/background/cursor colour. `?` or a `rgb:` reply
      // means this is a question or its answer; a plain value is a set.
      if (!/^1[012];(?:\?|rgb:)/.test(body)) out += sequence;
      continue;
    }

    if (next === "P") {
      // DCS: DECRQSS (`$q`) and XTGETTCAP (`+q`) are the two that reply.
      const st = text.indexOf(ST, esc + 2);
      if (st === -1) break;
      const body = text.slice(esc + 2, st);
      const sequence = text.slice(esc, st + 2);
      index = st + 2;
      if (!/^[01]?[$+][qr]/.test(body)) out += sequence;
      continue;
    }

    out += text[esc]!;
    index = esc + 1;
  }
  return out;
}

function pickTerminator(bel: number, st: number): { at: number; width: number } | -1 {
  if (bel === -1 && st === -1) return -1;
  if (bel !== -1 && (st === -1 || bel < st)) return { at: bel, width: 1 };
  return { at: st, width: 2 };
}

function isCsiQuery(params: string, intermediates: string, final: string): boolean {
  // Device Status Report, and the Cursor Position Report that answers it.
  if (final === "n" || final === "R") return true;
  // Primary/secondary Device Attributes, and XTVERSION (`CSI > q`).
  if (final === "c") return true;
  if (final === "q" && params.startsWith(">")) return true;
  // DECRQM / DECRPM — but `CSI ! p` (soft reset) and `CSI " p` (DECSCL) set.
  if ((final === "p" || final === "y") && intermediates.includes("$")) return true;
  // The Kitty keyboard protocol query; `CSI = u` and `CSI < u` push/pop state.
  if (final === "u" && params.startsWith("?")) return true;
  return false;
}

/**
 * Keep the tail of the scrollback under the cap.
 *
 * Cutting at an arbitrary byte would land inside an escape sequence and leave
 * the replay parsing garbage, so the cut is advanced to the next line boundary.
 */
export function trimHistory(history: string, maxBytes = MAX_HISTORY_BYTES): string {
  if (history.length <= maxBytes) return history;
  const cut = history.length - maxBytes;
  const newline = history.indexOf("\n", cut);
  return newline === -1 ? history.slice(cut) : history.slice(newline + 1);
}

// ---------------------------------------------------------------------------
// Requests off the wire

/**
 * The renderer validates too, but this is the trust boundary: what arrives is
 * whatever the IPC channel was handed, and the type on the other side describes
 * only what *this build* sends.
 */
export function parseTerminalId(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const id = input.trim();
  if (id.length === 0 || id.length > MAX_TERMINAL_ID) return null;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) ? id : null;
}

function parseSize(cols: unknown, rows: unknown): { cols: number; rows: number } | null {
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) return null;
  const c = cols as number;
  const r = rows as number;
  if (c < 1 || c > MAX_COLS || r < 1 || r > MAX_ROWS) return null;
  return { cols: c, rows: r };
}

export function parseOpenRequest(input: unknown): TerminalOpenRequest | null {
  if (typeof input !== "object" || input === null) return null;
  const record = input as Record<string, unknown>;
  const terminalId = parseTerminalId(record.terminalId);
  if (terminalId === null) return null;
  const size = parseSize(record.cols, record.rows);
  if (size === null) return null;
  return { terminalId, ...size };
}

export function parseWriteRequest(input: unknown): TerminalWriteRequest | null {
  if (typeof input !== "object" || input === null) return null;
  const record = input as Record<string, unknown>;
  const terminalId = parseTerminalId(record.terminalId);
  if (terminalId === null) return null;
  if (typeof record.data !== "string" || record.data.length === 0) return null;
  if (record.data.length > MAX_WRITE_BYTES) return null;
  return { terminalId, data: record.data };
}

export function parseResizeRequest(input: unknown): TerminalResizeRequest | null {
  if (typeof input !== "object" || input === null) return null;
  const record = input as Record<string, unknown>;
  const terminalId = parseTerminalId(record.terminalId);
  if (terminalId === null) return null;
  const size = parseSize(record.cols, record.rows);
  if (size === null) return null;
  return { terminalId, ...size };
}

// ---------------------------------------------------------------------------
// Sessions

type Listener = (event: TerminalEvent) => void;

interface Session {
  terminalId: string;
  root: string;
  pty: PtyProcess;
  cols: number;
  rows: number;
  history: string;
  sequence: number;
  status: "running" | "exited";
  listeners: Set<Listener>;
  /** Coalescing buffer: one IPC message per flush window, not per chunk. */
  pending: string;
  flush: ReturnType<typeof setTimeout> | null;
  kill: ReturnType<typeof setTimeout> | null;
}

/**
 * Every terminal opened during this app lifetime, keyed by project and id.
 *
 * Scoped to the project rather than to a thread: a terminal is a place in the
 * repo, not a conversation, and the mode that shows it is a peer of Code.
 * Hiding a terminal never closes it — only an explicit close, or quitting, does.
 */
export class TerminalSessions {
  readonly #deps: TerminalDeps;
  readonly #sessions = new Map<string, Session>();

  constructor(deps: TerminalDeps) {
    this.#deps = deps;
  }

  #key(root: string, terminalId: string): string {
    return `${root}\u0000${terminalId}`;
  }

  /** Ids of the live terminals for one project, in creation order. */
  list(root: string): string[] {
    return [...this.#sessions.values()]
      .filter((session) => session.root === root)
      .map((session) => session.terminalId);
  }

  /**
   * Open, or adopt what is already running.
   *
   * Idempotent on purpose: the renderer calls this every time the view mounts,
   * and a second call must not replace a shell someone is in the middle of using.
   */
  open(
    request: TerminalOpenRequest,
    root: string,
    listener: Listener,
  ): TerminalResult<{ snapshot: TerminalSnapshot; detach: () => void }> {
    const key = this.#key(root, request.terminalId);
    const existing = this.#sessions.get(key);
    if (existing !== undefined) {
      if (existing.status === "running") {
        this.#applyResize(existing, request.cols, request.rows);
      }
      return { ok: true, value: this.#attach(existing, listener) };
    }

    if (!this.#deps.isDirectory(root)) {
      return { ok: false, error: `not a directory: ${root}` };
    }

    const spawned = this.#spawn(root, request.cols, request.rows);
    if (!spawned.ok) return spawned;

    const session: Session = {
      terminalId: request.terminalId,
      root,
      pty: spawned.value,
      cols: request.cols,
      rows: request.rows,
      history: "",
      sequence: 0,
      status: "running",
      listeners: new Set(),
      pending: "",
      flush: null,
      kill: null,
    };
    this.#sessions.set(key, session);
    this.#wire(session);
    return { ok: true, value: this.#attach(session, listener) };
  }

  #spawn(root: string, cols: number, rows: number): TerminalResult<PtyProcess> {
    const env = terminalEnv(this.#deps.env);
    const name = this.#deps.platform === "win32" ? "xterm-color" : "xterm-256color";
    const attempted: string[] = [];
    let last = "";
    for (const candidate of shellCandidates(this.#deps)) {
      attempted.push(candidate.file);
      try {
        return {
          ok: true,
          value: this.#deps.spawn(candidate.file, candidate.args, {
            cwd: root,
            cols,
            rows,
            env,
            name,
          }),
        };
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
        if (!isMissingBinary(error)) return { ok: false, error: last };
      }
    }
    return { ok: false, error: `no shell could be started (tried ${attempted.join(", ")}): ${last}` };
  }

  #wire(session: Session): void {
    session.pty.onData((data) => {
      session.history = trimHistory(session.history + data);
      session.pending += data;
      if (session.flush !== null) return;
      session.flush = setTimeout(() => {
        session.flush = null;
        const data = session.pending;
        session.pending = "";
        if (data.length > 0) {
          session.sequence += 1;
          this.#emit(session, {
            type: "output",
            terminalId: session.terminalId,
            sequence: session.sequence,
            data,
          });
        }
      }, this.#deps.flushMs ?? DEFAULT_FLUSH_MS);
    });

    session.pty.onExit(({ exitCode, signal }) => {
      // The shell beat our SIGKILL to it; nothing left to escalate to.
      if (session.kill !== null) {
        clearTimeout(session.kill);
        session.kill = null;
      }
      session.status = "exited";
      this.#flushNow(session);
      session.sequence += 1;
      this.#emit(session, {
        type: "exit",
        terminalId: session.terminalId,
        sequence: session.sequence,
        exitCode,
        signal: signal ?? null,
      });
    });
  }

  #flushNow(session: Session): void {
    if (session.flush !== null) {
      clearTimeout(session.flush);
      session.flush = null;
    }
    if (session.pending.length === 0) return;
    const data = session.pending;
    session.pending = "";
    session.sequence += 1;
    this.#emit(session, {
      type: "output",
      terminalId: session.terminalId,
      sequence: session.sequence,
      data,
    });
  }

  #emit(session: Session, event: TerminalEvent): void {
    for (const listener of [...session.listeners]) listener(event);
  }

  /**
   * Snapshot and subscribe, with nothing between them.
   *
   * This runs to completion before the event loop can deliver another pty chunk,
   * which is what makes the pair atomic: no output can slip through the gap
   * between reading `history` and installing the listener, so a client neither
   * misses a chunk nor sees one twice.
   */
  #attach(
    session: Session,
    listener: Listener,
  ): { snapshot: TerminalSnapshot; detach: () => void } {
    this.#flushNow(session);
    session.listeners.add(listener);
    return {
      snapshot: {
        terminalId: session.terminalId,
        pid: session.pty.pid,
        cols: session.cols,
        rows: session.rows,
        history: sanitizeReplay(session.history),
        sequence: session.sequence,
        status: session.status,
      },
      detach: () => {
        session.listeners.delete(listener);
      },
    };
  }

  /** Keystrokes. Writing to a dead shell is a no-op, not an error. */
  write(request: TerminalWriteRequest, root: string): TerminalResult<null> {
    const session = this.#sessions.get(this.#key(root, request.terminalId));
    if (session === undefined) return { ok: false, error: "no such terminal" };
    // A key pressed in the instant a shell exits is not worth an error dialog.
    if (session.status !== "running") return { ok: true, value: null };
    try {
      session.pty.write(request.data);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    return { ok: true, value: null };
  }

  /**
   * Resize. Silent when the terminal is gone: a ResizeObserver can already have
   * queued a call by the time the view unmounts, and that is not a fault.
   */
  resize(request: TerminalResizeRequest, root: string): TerminalResult<null> {
    const session = this.#sessions.get(this.#key(root, request.terminalId));
    if (session === undefined || session.status !== "running") {
      return { ok: true, value: null };
    }
    this.#applyResize(session, request.cols, request.rows);
    return { ok: true, value: null };
  }

  #applyResize(session: Session, cols: number, rows: number): void {
    if (session.cols === cols && session.rows === rows) return;
    session.cols = cols;
    session.rows = rows;
    try {
      session.pty.resize(cols, rows);
    } catch {
      // A shell that died mid-drag cannot be resized; its exit is already coming.
    }
  }

  /** Close one terminal and forget its scrollback. */
  close(terminalId: string, root: string): TerminalResult<null> {
    const key = this.#key(root, terminalId);
    const session = this.#sessions.get(key);
    if (session === undefined) return { ok: true, value: null };
    this.#sessions.delete(key);
    this.#stop(session);
    return { ok: true, value: null };
  }

  /**
   * SIGTERM, then SIGKILL if the shell is still there.
   *
   * Listeners are dropped first so a dying shell cannot deliver output to a view
   * that has already been told the terminal is gone.
   */
  #stop(session: Session): void {
    session.listeners.clear();
    if (session.flush !== null) {
      clearTimeout(session.flush);
      session.flush = null;
    }
    if (session.status !== "running") return;
    session.status = "exited";
    try {
      session.pty.kill("SIGTERM");
    } catch {
      return;
    }
    session.kill = setTimeout(() => {
      session.kill = null;
      try {
        session.pty.kill("SIGKILL");
      } catch {
        // Already reaped between the two signals, which is the good case.
      }
    }, this.#deps.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
    session.kill.unref?.();
  }

  /** Quitting: every project, every terminal. */
  disposeAll(): void {
    const open = [...this.#sessions.values()];
    this.#sessions.clear();
    for (const session of open) this.#stop(session);
  }
}
