#!/usr/bin/env node
import { parseArgs } from "node:util";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { boot, type PatchRow } from "@daydream-code/boot";
import type { FiberDump } from "@daydream-code/kernel";
import { sessionActivityAt, type JournalEvent } from "@daydream-code/shared";
import type {} from "@daydream-code/session";
import type {} from "@daydream-code/driver";
import type {} from "@daydream-code/journal";
import type {} from "@daydream-code/thread";
import type {} from "@daydream-code/store";
import type { PendingQuestion, Question } from "@daydream-code/questions";
import type {} from "@daydream-code/questions";

const HELP = `daydream-code — a coding harness on a continuous journaled thread

usage:
  daydream-code run "<task>"                dispatch a session against the project
  daydream-code continue <session> "<msg>"  continue a session, by name or id
  daydream-code sessions                    list sessions
  daydream-code models                      list each driver's selectable models
  daydream-code master [--all]              show the master thread (live context, or --all for full history)
  daydream-code journal <session>           replay a session's journal, by name or id
  daydream-code dump-config                 print the composed plugin config (same compose path as boot)
  daydream-code fiber-state                 dump plugin fiber states (find silently-PENDING plugins)
  daydream-code serve                       boot with the server plugin enabled

options:
  --project <path>   project root (default: cwd)
  --driver <id>      driver for this dispatch (claude, codex, mock)
  --model <id>       model id passed to the driver
  --effort <level>   reasoning effort passed to the driver (e.g. low, high, xhigh)
  --fast             request the provider's lower-latency fast mode
  --name <name>      name for this session (default: derived from the task)
  --image <path>     attach an image (png/jpeg/gif/webp; repeatable)
  --enable <id>      enable a config row (repeatable)
  --disable <id>     disable a config row (repeatable)
  --quiet            suppress journal event streaming
`;

/**
 * Attached-mode answering. `run` and `continue` hold the process that owns the
 * pending promise, so the terminal can settle a question directly — no server
 * round trip, and no cross-process path to get wrong.
 *
 * Without a TTY there is nobody to ask, so the question is declined at once
 * rather than left to hang. That is not a timeout: the harness has none by
 * design. It is the honest answer to "is a human attached here", known
 * immediately and answered immediately.
 */
function attachQuestionPrompt(ctx: {
  on: (name: string, listener: (...args: any[]) => any) => () => void;
  questions: {
    settle: (requestId: string, outcome: any) => boolean;
  };
}): () => void {
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  let chain: Promise<void> = Promise.resolve();
  let rl: import("node:readline/promises").Interface | undefined;

  const off = ctx.on("question/asked", (pending: PendingQuestion) => {
    if (!interactive) {
      // Explain before settling: settling emits the journal event that the
      // attached printer renders, and the reason should precede the outcome.
      console.log(
        "? no terminal attached — declining, the session will proceed on its own recommendation",
      );
      ctx.questions.settle(pending.requestId, { kind: "declined" });
      return;
    }
    // Serialized: two questions must not race for the same stdin.
    chain = chain.then(async () => {
      const answers: Record<string, string | string[]> = {};
      for (const question of pending.questions) {
        const answer = await askOne(question);
        if (answer === null) {
          ctx.questions.settle(pending.requestId, { kind: "declined" });
          return;
        }
        answers[question.id] = answer;
      }
      ctx.questions.settle(pending.requestId, { kind: "answered", answers });
    });
  });

  async function askOne(question: Question): Promise<string | string[] | null> {
    const { createInterface } = await import("node:readline/promises");
    rl ??= createInterface({ input: process.stdin, output: process.stdout });
    const hint = question.multiSelect
      ? "numbers separated by commas, or your own words"
      : "a number, or your own words";
    const raw = (
      await rl.question(`  answer (${hint}; empty = you decide): `)
    ).trim();
    if (raw === "") return null;
    // Prose beats the offered options, matching every other answering surface.
    const picks = raw
      .split(",")
      .map((part) => part.trim())
      .map((part) => (/^\d+$/.test(part) ? question.options[Number(part) - 1] : undefined));
    if (picks.length > 0 && picks.every((option) => option !== undefined)) {
      const labels = picks.map((option) => option!.label);
      return question.multiSelect ? labels : labels[0]!;
    }
    return raw;
  }

  return () => {
    off();
    rl?.close();
  };
}

/**
 * A plugin that fails to load leaves its service unprovided, and the first
 * thing a command does with it is read a property off `undefined` — so the
 * last line the user reads is a TypeError from this file rather than the
 * failure that caused it. The cause is already sitting in `app.dumpState()`.
 *
 * Only a fiber that actually threw counts as fatal. A `pending` fiber with
 * unmet `inject` names can be a legitimately-disabled optional row, and
 * refusing to run over one would break healthy trees; those are reported as
 * context instead.
 */
const NATIVE_ABI = /NODE_MODULE_VERSION|ERR_DLOPEN_FAILED/;

export function bootDiagnosis(fibers: readonly FiberDump[]): string | null {
  const failed = fibers.filter((fiber) => fiber.error !== undefined);
  if (failed.length === 0) return null;

  const lines = [
    "this command has nothing to run against: the harness did not finish booting.",
    "",
  ];
  for (const fiber of failed) {
    const first = (fiber.error ?? "").split("\n")[0] ?? "";
    lines.push(`  ${fiber.name} failed: ${first.slice(0, 160)}`);
  }
  // Everything downstream of a failed provider is missing too. Enumerating the
  // cascade buries the one line that matters, so it is counted, not listed.
  const waiting = fibers.filter(
    (fiber) => fiber.error === undefined && fiber.missing.length > 0,
  );
  if (waiting.length > 0) {
    lines.push(
      `  ${waiting.length} more plugin(s) never loaded as a result.`,
    );
  }
  // This repo's most common broken state, and the one that reads as five
  // unrelated bugs: `pnpm dev` builds better-sqlite3 against Electron's ABI,
  // then the CLI runs under plain node and cannot load it.
  if (failed.some((fiber) => NATIVE_ABI.test(fiber.error ?? ""))) {
    lines.push(
      "",
      "better-sqlite3 is built for Electron's ABI; this command runs under node.",
      "  rebuild it:  pnpm -C apps/desktop rebuild:node",
      "`pnpm dev` and `pnpm start` swap it back to Electron on their own, so",
      "expect to alternate if you are running the desktop app and the CLI.",
    );
  }
  lines.push("", "full plugin state:  daydream-code fiber-state");
  return lines.join("\n");
}

function fmtEvent(event: JournalEvent): string {
  const payload = event.payload as Record<string, unknown> | null;
  const short = (value: unknown, n = 160): string => {
    const text =
      typeof value === "string" ? value : JSON.stringify(value ?? "");
    return text.length > n ? `${text.slice(0, n)}…` : text;
  };
  switch (event.type) {
    case "turn":
      return `● ${short(payload?.text, 400)}`;
    case "thinking":
      return `∴ ${short(payload?.text)}`;
    case "tool_call":
      return `→ ${String(payload?.toolName ?? payload?.tool ?? "tool")} ${short(payload?.args ?? payload)}`;
    case "tool_result":
      return `← ${short(payload?.result ?? payload)}`;
    case "turn_end":
      return `■ turn end`;
    case "question_asked": {
      const questions = (payload?.questions ?? []) as Question[];
      return questions
        .map(
          (q) =>
            `? [${q.header}] ${q.question}\n${q.options
              .map((o, i) => `    ${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`)
              .join("\n")}`,
        )
        .join("\n");
    }
    case "question_settled": {
      const kind = String(payload?.kind ?? "");
      if (kind === "answered") return `✓ answered ${short(payload?.answers)}`;
      if (kind === "replied") return `✓ replied ${short(payload?.text)}`;
      if (kind === "declined") return `✓ declined — proceeding on the model's recommendation`;
      return `✓ question cancelled: ${short(payload?.reason)}`;
    }
    case "driver_error":
      return `✗ ${short(payload?.error, 400)}`;
    default:
      return `· ${event.type} ${short(payload)}`;
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      project: { type: "string" },
      driver: { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      fast: { type: "boolean" },
      name: { type: "string" },
      image: { type: "string", multiple: true },
      enable: { type: "string", multiple: true },
      disable: { type: "string", multiple: true },
      all: { type: "boolean" },
      quiet: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    console.log(HELP);
    return values.help ? 0 : 1;
  }
  const projectRoot = resolve(values.project ?? process.cwd());
  const overrides: PatchRow[] = [
    ...(values.enable ?? []).map((id) => ({ id, disabled: false })),
    ...(values.disable ?? []).map((id) => ({ id, disabled: true })),
  ];
  if (command === "serve") overrides.push({ id: "server", disabled: false });

  // Bare plugin specifiers resolve from this app's own dependency tree first.
  const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");

  if (command === "dump-config") {
    const result = await boot({ projectRoot, overrides, composeOnly: true });
    console.log(result.dumpConfig());
    return 0;
  }

  const result = await boot({ projectRoot, overrides, resolutionPaths: [appDir] });
  const { ctx, app } = result;

  // `fiber-state` is the tool for reading a broken boot, so it must survive one.
  const diagnosis = command === "fiber-state" ? null : bootDiagnosis(app.dumpState());
  if (diagnosis !== null) {
    console.error(diagnosis);
    await app.dispose(app.rootFiber).catch(() => undefined);
    return 1;
  }

  try {
    switch (command) {
      case "fiber-state": {
        for (const fiber of app.dumpState()) {
          const missing = fiber.missing.length
            ? `  MISSING: ${fiber.missing.join(", ")}`
            : "";
          const error = fiber.error ? `  ERROR: ${fiber.error}` : "";
          console.log(
            `${fiber.state.padEnd(9)} ${fiber.name}${missing}${error}`,
          );
        }
        return 0;
      }
      case "models": {
        for (const entry of ctx.drivers.catalog()) {
          console.log(entry.driver);
          if (entry.models.length === 0) console.log("  (driver default only)");
          for (const model of entry.models) {
            const notes = [
              ...(model.description !== undefined ? [model.description] : []),
              ...(model.isDefault === true ? ["default"] : []),
            ];
            console.log(
              `  ${model.id.padEnd(22)} ${model.label}${notes.length > 0 ? `  (${notes.join(", ")})` : ""}`,
            );
          }
        }
        return 0;
      }
      case "sessions": {
        // Already most-recently-active first; see SessionRunner.list. The
        // timestamp printed is the one it is sorted on — when a finished
        // session finished, when a live one started — which the status column
        // beside it disambiguates.
        const rows = ctx.sessions.list();
        // Pad names to the widest so the columns line up regardless of length.
        const width = Math.max(0, ...rows.map((s) => s.name.length));
        for (const s of rows) {
          console.log(
            `${s.name.padEnd(width)}  ${s.status.padEnd(9)}  ${s.driver.padEnd(6)}  ${sessionActivityAt(s)}  ${s.title}`,
          );
        }
        return 0;
      }
      case "master": {
        const master = ctx.threads.ensureMaster();
        const entries = values.all
          ? ctx.threads.entries(master.id)
          : ctx.threads.liveContext(master.id);
        for (const entry of entries) {
          const text =
            typeof entry.message.content === "string"
              ? entry.message.content
              : JSON.stringify(entry.message.content);
          console.log(`[${entry.seq}] (${entry.kind}) ${text}`);
        }
        return 0;
      }
      case "journal": {
        const key = positionals[1];
        if (!key) {
          console.error("usage: daydream-code journal <session>");
          return 1;
        }
        const session = ctx.sessions.resolve(key);
        if (!session) {
          console.error(`unknown session "${key}"`);
          return 1;
        }
        for (const event of ctx.journal.read({
          sessionId: session.id,
          limit: 1000,
        })) {
          console.log(`${event.ts} ${fmtEvent(event)}`);
        }
        return 0;
      }
      case "run":
      case "continue": {
        // Paths are resolved against the cwd, not the project root: you are
        // usually attaching a screenshot from wherever you happen to be.
        const attachments = (values.image ?? []).map((path) => ({
          path: resolve(path),
        }));
        if (!values.quiet) {
          ctx.on("journal/append", (event: JournalEvent) =>
            console.log(fmtEvent(event)),
          );
        }
        const detachPrompt = attachQuestionPrompt(ctx as never);
        let done: Promise<unknown>;
        if (command === "run") {
          const task = positionals[1];
          if (!task) {
            console.error('usage: daydream-code run "<task>"');
            return 1;
          }
          const handle = await ctx.sessions.dispatch({
            task,
            ...(values.driver ? { driver: values.driver } : {}),
            ...(values.model ? { modelId: values.model } : {}),
            ...(values.effort ? { effort: values.effort } : {}),
            ...(values.fast ? { fastMode: true } : {}),
            ...(values.name ? { name: values.name } : {}),
            ...(attachments.length > 0 ? { attachments } : {}),
          });
          console.log(
            `session ${handle.record.name} dispatched: ${handle.record.title}`,
          );
          done = handle.done;
        } else {
          const key = positionals[1];
          const message = positionals[2];
          if (!key || !message) {
            console.error('usage: daydream-code continue <session> "<msg>"');
            return 1;
          }
          const session = ctx.sessions.resolve(key);
          if (!session) {
            console.error(`unknown session "${key}"`);
            return 1;
          }
          const handle = await ctx.sessions.continueSession(
            session.id,
            message,
            attachments,
          );
          done = handle.done;
        }
        const final = (await done) as {
          name: string;
          status: string;
          summary: string | null;
        };
        detachPrompt();
        console.log(`\nsession ${final.name} ${final.status}`);
        if (final.summary) console.log(final.summary);
        return final.status === "completed" ? 0 : 1;
      }
      case "serve": {
        console.log("server running; ctrl-c to stop");
        await new Promise(() => undefined);
        return 0;
      }
      default:
        console.error(`unknown command "${command}"\n`);
        console.log(HELP);
        return 1;
    }
  } finally {
    if (command !== "serve") {
      await app.dispose(app.rootFiber).catch(() => undefined);
    }
  }
}

/**
 * Run the CLI only when this module *is* the entry script, never when
 * something imports it.
 *
 * `basename` rather than a hand-rolled `split(/[\\/]/).pop()`: that returned
 * `string | undefined`, so it needed a fallback needle, and every candidate is
 * a trap. `""` makes `endsWith` true for any string — `main()` would run on
 * import — and the `"\0"` it replaced was written into the file as a literal
 * NUL byte, which is what makes git refuse to diff this file as text (see
 * `.gitattributes`). `basename` returns a plain `string`, so there is no
 * fallback to get wrong, and it splits on the platform's own separator.
 */
const entry = process.argv[1];
const isDirect = entry !== undefined && import.meta.url.endsWith(basename(entry));
if (isDirect) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
