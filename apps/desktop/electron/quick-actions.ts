/**
 * Quick actions: the toolbar's one gesture that reaches outside the app.
 *
 * Opening the project folder, dropping into a terminal at its root, or running
 * a command the person keeps re-typing are all the same shape — a thing done
 * *to the open project*, from the window that already knows which project that
 * is. They live in main because a renderer has no filesystem, no shell and no
 * Finder, and because the project root must come from the supervisor rather
 * than from the wire: main is the only side that knows which project is open,
 * so a request never carries a path to run in.
 *
 * Electron is injected rather than imported so this file is testable under
 * plain node — the same reason `registry.ts` and `stats.ts` stay importable.
 */
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";

export type QuickActionRequest =
  | { kind: "reveal" }
  | { kind: "terminal" }
  | { kind: "command"; command: string };

/**
 * `detail` is what happened when nothing went wrong but something is worth
 * saying — a command still running after the grace window is the only case.
 */
export type QuickActionResult =
  | { ok: true; detail?: string }
  | { ok: false; error: string };

export interface Launch {
  file: string;
  args: string[];
}

type Spawn = (
  file: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface QuickActionDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  spawn: Spawn;
  /** `shell.openPath`: resolves to "" on success, or to the OS's complaint. */
  openPath(path: string): Promise<string>;
  /** True when this executable is on PATH. Injected so tests need no PATH. */
  onPath?(file: string): boolean;
  /** How long to watch a spawned command before calling it launched. */
  graceMs?: number;
}

/** A command a person can type is not a command we should run unexamined. */
export const MAX_COMMAND_LENGTH = 2000;
const DEFAULT_GRACE_MS = 1500;
const STDERR_TAIL = 4000;

/**
 * Terminals that open at their working directory with no flags, most specific
 * first. `x-terminal-emulator` is Debian's alternatives entry, so it stands in
 * for whatever the distribution actually installed.
 */
const LINUX_TERMINALS = [
  "x-terminal-emulator",
  "gnome-terminal",
  "konsole",
  "xfce4-terminal",
  "alacritty",
  "kitty",
  "wezterm",
  "xterm",
];

/** `which`, without a subprocess: PATH lookup is all the answer needs to be. */
export function onPathDefault(env: NodeJS.ProcessEnv, file: string): boolean {
  const path = env.PATH;
  if (path === undefined || path.length === 0) return false;
  return path
    .split(delimiter)
    .some((dir) => dir.length > 0 && existsSync(join(dir, file)));
}

/**
 * How to open a terminal at `root`, or null when the platform has none we
 * recognize.
 *
 * `DAYDREAM_TERMINAL` is the escape hatch on every platform: the macOS branch
 * treats it as an application name (`iTerm`), the Linux branch as an
 * executable. Hardcoding one terminal per OS would be wrong for most people
 * who care which terminal they use.
 */
export function terminalLaunch(
  root: string,
  deps: Pick<QuickActionDeps, "platform" | "env" | "onPath">,
): Launch | null {
  const preferred = deps.env.DAYDREAM_TERMINAL?.trim();
  if (deps.platform === "darwin") {
    const app = preferred !== undefined && preferred.length > 0 ? preferred : "Terminal";
    return { file: "open", args: ["-a", app, root] };
  }
  if (deps.platform === "win32") {
    // `start` needs an empty title argument, or it eats the first quoted one.
    return { file: "cmd.exe", args: ["/d", "/s", "/c", "start", "", "cmd.exe"] };
  }
  const onPath = deps.onPath ?? ((file: string) => onPathDefault(deps.env, file));
  const candidates =
    preferred !== undefined && preferred.length > 0
      ? [preferred, ...LINUX_TERMINALS]
      : LINUX_TERMINALS;
  const found = candidates.find((file) => onPath(file));
  return found === undefined ? null : { file: found, args: [] };
}

/**
 * How to run a custom action.
 *
 * Through the person's login shell, not `execFile`: a quick action is a shell
 * line (`code .`, `pnpm dev`, `git fetch && git status`), and the tools it
 * reaches for are usually on a PATH that only a login shell assembles — a GUI
 * app on macOS inherits launchd's PATH, which has no `code`, no `pnpm` and no
 * version manager in it.
 */
export function commandLaunch(
  command: string,
  deps: Pick<QuickActionDeps, "platform" | "env">,
): Launch {
  if (deps.platform === "win32") {
    return { file: deps.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", command] };
  }
  const shell =
    deps.env.SHELL !== undefined && deps.env.SHELL.length > 0
      ? deps.env.SHELL
      : "/bin/sh";
  return { file: shell, args: ["-lc", command] };
}

/**
 * A request off the wire, or null.
 *
 * The renderer validates too, but this is the trust boundary: what arrives is
 * whatever the IPC channel was handed, and the type on the other side
 * describes only what *this build* sends.
 */
export function parseRequest(input: unknown): QuickActionRequest | null {
  if (typeof input !== "object" || input === null) return null;
  const record = input as Record<string, unknown>;
  if (record.kind === "reveal") return { kind: "reveal" };
  if (record.kind === "terminal") return { kind: "terminal" };
  if (record.kind !== "command") return null;
  const command = typeof record.command === "string" ? record.command.trim() : "";
  if (command.length === 0 || command.length > MAX_COMMAND_LENGTH) return null;
  if (command.includes("\0")) return null;
  return { kind: "command", command };
}

/**
 * Spawn, and watch it just long enough to be honest about the outcome.
 *
 * A quick action that fails immediately (a typo'd binary, a script that exits
 * 1) should say so — fire-and-forget would report success for `cdoe .` and
 * leave the person staring at a window where nothing happened. A quick action
 * that is still going after the grace window is a server or an editor, and
 * waiting on it would hang the popover, so it is released and reported as
 * launched. Output keeps draining into a bounded tail rather than being closed
 * off, because destroying the pipes would EPIPE a long-running child.
 */
function spawnWatched(
  launch: Launch,
  cwd: string,
  deps: QuickActionDeps,
): Promise<QuickActionResult> {
  return new Promise((done) => {
    let child: ChildProcess;
    try {
      child = deps.spawn(launch.file, launch.args, {
        cwd,
        env: deps.env,
        // Its own process group on POSIX, so quitting the app does not take
        // down the dev server someone just started.
        detached: deps.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      done({ ok: false, error: messageOf(error) });
      return;
    }

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = `${stderr}${String(chunk)}`.slice(-STDERR_TAIL);
    });
    child.stdout?.on("data", () => undefined);

    let settled = false;
    const settle = (result: QuickActionResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(result);
    };

    const timer = setTimeout(() => {
      child.unref();
      settle({ ok: true, detail: "still running" });
    }, deps.graceMs ?? DEFAULT_GRACE_MS);

    child.on("error", (error: Error) => settle({ ok: false, error: error.message }));
    child.on("exit", (code, signal) => {
      if (code === 0 || code === null) {
        settle({ ok: true });
        return;
      }
      const tail = lastLine(stderr);
      settle({
        ok: false,
        error:
          tail.length > 0
            ? tail
            : `exited with ${signal !== null ? `signal ${signal}` : `code ${String(code)}`}`,
      });
    });
  });
}

function lastLine(text: string): string {
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  return lines[lines.length - 1] ?? "";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Run one action against the open project's root. */
export async function runQuickAction(
  input: unknown,
  root: string,
  deps: QuickActionDeps,
): Promise<QuickActionResult> {
  const request = parseRequest(input);
  if (request === null) return { ok: false, error: "invalid quick action" };

  if (request.kind === "reveal") {
    const failure = await deps.openPath(root);
    return failure === "" ? { ok: true } : { ok: false, error: failure };
  }

  if (request.kind === "terminal") {
    const launch = terminalLaunch(root, deps);
    if (launch === null) {
      return {
        ok: false,
        error: "no terminal found — set DAYDREAM_TERMINAL to the one you use",
      };
    }
    return spawnWatched(launch, root, deps);
  }

  return spawnWatched(commandLaunch(request.command, deps), root, deps);
}
