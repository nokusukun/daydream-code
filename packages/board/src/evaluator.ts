import { defineConfig, field, type ConfigOf } from "@daydream-code/config";
import type { Context } from "@daydream-code/kernel";
import { LIVE_STATUSES, type JournalEvent, type SessionId, type SessionRecord } from "@daydream-code/shared";
import type { DispatchRequest } from "@daydream-code/session";
import type { ToolRunContext } from "@daydream-code/tools";
import type {} from "@daydream-code/session";
import type {} from "@daydream-code/tools";
import type {} from "@daydream-code/journal";
import type {} from "@daydream-code/workspace";
import { BoardError, type BoardCard, type BoardColumn, type VerdictInput } from "./index.js";

type EvaluatorPermission = "auto" | "ask" | "readonly";
const PERMISSION_MODES: ReadonlyArray<{ value: EvaluatorPermission; label: string }> = [
  { value: "auto", label: "auto" },
  { value: "ask", label: "ask" },
  { value: "readonly", label: "readonly" },
];

export const { Config, settings } = defineConfig({
  driver: field.string({
    label: "evaluator driver",
    help: "which agent judges whether a card can run alongside what is live. Empty means the project default.",
    optional: true,
  }),
  modelId: field.string({
    label: "evaluator model",
    help: "model id passed through to the evaluator's driver. Empty means the driver default.",
    optional: true,
  }),
  effort: field.string({
    label: "evaluator effort",
    help: "reasoning effort in the driver's own vocabulary. Empty means the driver default.",
    optional: true,
  }),
  permissionMode: field.enum({
    label: "evaluator permissions",
    help: "the evaluator only needs to read the tree, but readonly is a driver-level mode and some drivers refuse git under it.",
    options: PERMISSION_MODES,
    default: "auto" as const,
  }),
  skipWhenIdle: field.boolean({
    label: "skip evaluation when idle",
    help: "start a card at once when nothing is Working and no card is Evaluating ahead of it — the only verdict an evaluator could reach there is proceed.",
    default: true,
  }),
  timeoutMs: field.number({
    label: "evaluation timeout",
    help: "an evaluator still running after this is stopped and the card goes to Needs Attention. Sized for a model that reads a few files and maybe asks one sibling, not for a full run.",
    default: 600_000,
    integer: true,
    min: 1_000,
    unit: "ms",
  }),
});

export type EvaluatorConfig = ConfigOf<typeof Config>;

/** Tool names whose arguments name a file the session changed. */
const WRITE_TOOLS = /edit|write|create|patch|notebook|apply/i;
const PATH_KEYS = ["file_path", "path", "filePath", "notebook_path", "target_file"];

/**
 * Files a session has written, read out of its own journal. Heuristic on
 * purpose: tool vocabularies differ per driver, and a file overlap call does
 * not need to be exact, it needs to be cheap and mostly right.
 */
function touchedFiles(events: JournalEvent[]): string[] {
  const files = new Set<string>();
  for (const event of events) {
    if (event.type !== "tool_call") continue;
    const payload = event.payload as { name?: unknown; args?: unknown };
    if (typeof payload?.name !== "string" || !WRITE_TOOLS.test(payload.name)) continue;
    const args = payload.args;
    if (typeof args !== "object" || args === null) continue;
    for (const key of PATH_KEYS) {
      const value = (args as Record<string, unknown>)[key];
      if (typeof value === "string" && value.length > 0) files.add(value);
    }
  }
  return [...files].sort();
}

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

/**
 * Consumer plugin: the default evaluation strategy. A real session, on the
 * project's own agent unless configured otherwise, judges each card that
 * enters Evaluating and reports through `board_verdict`.
 *
 * A session rather than a bare model call because the question is about the
 * working tree — which files a live run has touched, whether the new task
 * would cross them — and a session can go and look. It shows in the rail
 * like any other run; the board keeps it out of the columns.
 *
 * One mechanical fast path (`skipWhenIdle`, on by default): when the board is
 * idle the verdict is provably `proceed` — see `foregone` — and the card
 * starts without an evaluator at all.
 */
const boardEvaluator = {
  name: "board-evaluator",
  inject: ["board", "sessions", "tools", "journal", "workspace"] as const,
  apply(ctx: Context, config: EvaluatorConfig) {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    ctx.effect(() => () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    }, "evaluation timers");

    const workingSessions = (): Array<{ card: BoardCard; session: SessionRecord }> =>
      ctx.board
        .list()
        .filter((c) => c.column === "working" && c.sessionId !== null)
        .flatMap((card) => {
          const session = ctx.sessions.get(card.sessionId!);
          return session === undefined ? [] : [{ card, session }];
        });

    /** Cards ahead of `card` in queue order that have not started: the `defer` targets. */
    const waitingAhead = (card: BoardCard): BoardCard[] =>
      ctx.board
        .list()
        .filter(
          (c) =>
            c.id !== card.id &&
            (c.column === "queued" || c.column === "evaluating" || c.column === "blocked") &&
            c.position < card.position,
        );

    const prompt = async (card: BoardCard): Promise<string> => {
      const working = workingSessions();
      const ahead = waitingAhead(card);
      let changed: string[] = [];
      try {
        changed = (await ctx.workspace.status()).files.map((f) => `${f.status} ${f.path}`);
      } catch {
        // No repo, or git is unhappy: the per-session lists still stand.
      }
      const lines: string[] = [
        "You are the evaluator for a kanban board of coding sessions that all share ONE working tree.",
        "A new card wants to start. Decide whether it can run right now alongside the sessions that are Working, or must wait.",
        "",
        "## The card",
        `id: ${card.id}`,
        `title: ${card.title}`,
        `driver: ${card.request.driver ?? "project default"}`,
        "task:",
        "```",
        card.task,
        "```",
        "",
        "## Working sessions (the only ones you may block on)",
      ];
      if (working.length === 0) {
        lines.push("(none — nothing is Working, so nothing can block this card)");
      }
      for (const { session } of working) {
        const files = touchedFiles(
          ctx.journal.read({ sessionId: session.id, types: ["tool_call"], limit: 500 }),
        );
        lines.push(
          `### ${session.name} (${session.status})`,
          `title: ${session.title}`,
          `task: ${clip(session.task, 400)}`,
          `last summary: ${session.tldr ?? "(none yet)"}`,
          `files it has written: ${files.length > 0 ? files.join(", ") : "(none recorded yet)"}`,
          "",
        );
      }
      lines.push(
        "## Uncommitted changes in the tree",
        changed.length > 0 ? changed.join("\n") : "(clean)",
        "",
        "## Cards ahead of this one that have not started (you may `defer` to any of these, never block on them)",
      );
      if (ahead.length === 0) lines.push("(none)");
      for (const c of ahead) {
        const waitingOn =
          c.column === "blocked" && c.blockedBy.length > 0
            ? ` (waiting on ${c.blockedBy.map((b) => b.blockerName).join(", ")})`
            : "";
        lines.push(`- ${c.id} [${c.column}${waitingOn}] ${c.title}: ${clip(c.task, 200)}`);
      }
      lines.push(
        "",
        "## How to decide",
        "- Judge two things: file overlap (would this card plausibly edit files a Working session has written or is about to?) and logical dependency (does this card need something a Working session is producing — a migration, an API, a decision?).",
        "- You may read files and run `git status` / `git diff` to check. Make NO edits.",
        "- If a Working session's *intent* is the deciding factor and its summary does not settle it, you may `ask_session` it once. Treat silence (an unanswered ask) as not blocking.",
        "- Also judge the cards ahead that have not started. Once one of them runs it may conflict with this card, even if nothing Working does now. If one would, `defer` to it. This card then waits until that one starts (or leaves the queue) and is evaluated again with it Working, so it can be blocked properly. Don't jump a conflicting card that got here first.",
        "- Finish by calling `board_verdict` exactly once. A `block` must name Working session names from the list above. Give a one-sentence reason a person will read on the card.",
      );
      return lines.join("\n");
    };

    /**
     * Whether the verdict is a foregone `proceed`: a `block` may only name
     * the sessions of Working cards, and a `defer` only a not-yet-started
     * card ahead in the queue — both enforced by the provider. With neither
     * in existence, an evaluator session could not reach any other
     * conclusion, so dispatching one would spend a model run to conclude the
     * inevitable. A Blocked card ahead counts even when nothing is Working:
     * its blocker can sit in Needs Attention, off the Working list but live.
     */
    const foregone = (card: BoardCard): boolean =>
      workingSessions().length === 0 && waitingAhead(card).length === 0;

    const evaluate = async (card: BoardCard): Promise<void> => {
      if (config.skipWhenIdle && foregone(card)) {
        // `start` is the board's sanctioned skip-evaluation move. A card
        // launching this way stays in Evaluating until its dispatch
        // resolves, so a sibling entering Evaluating meanwhile sees it
        // ahead, fails `foregone`, and gets a real evaluator.
        try {
          await ctx.board.start(card.id);
        } catch (error) {
          // The card moved on (a force start, a cancel) before the start
          // resolved, or the driver refused. Neither is this plugin's to fix.
          if (!(error instanceof BoardError)) {
            console.error(`[board-evaluator] could not start ${card.id}:`, error);
          }
        }
        return;
      }
      let task: string;
      try {
        task = await prompt(card);
      } catch (error) {
        // Building the prompt awaits git; if the plugin unloaded meanwhile
        // there is nothing to evaluate against and nothing to report to.
        if (ctx.get("board") === undefined) return;
        throw error;
      }
      if (ctx.get("board") === undefined) return;
      const request: DispatchRequest = {
        task,
        name: `evaluate ${card.title}`,
        permissionMode: config.permissionMode,
        ...(config.driver !== undefined ? { driver: config.driver } : {}),
        ...(config.modelId !== undefined ? { modelId: config.modelId } : {}),
        ...(config.effort !== undefined ? { effort: config.effort } : {}),
      };
      let handle;
      try {
        handle = await ctx.board.beginEvaluation(card.id, request);
      } catch (error) {
        // The card moved on (a force start, a cancel) before the dispatch
        // resolved, or the driver refused. Neither is this plugin's to fix.
        if (!(error instanceof BoardError)) {
          console.error(`[board-evaluator] could not evaluate ${card.id}:`, error);
        }
        return;
      }
      const evaluatorId = handle.record.id;
      const timer = setTimeout(() => {
        timers.delete(card.id);
        const fresh = ctx.board.get(card.id);
        if (fresh?.column !== "evaluating" || fresh.evaluatorSessionId !== evaluatorId) return;
        const session = ctx.sessions.get(evaluatorId);
        if (session !== undefined && LIVE_STATUSES.includes(session.status)) {
          void ctx.sessions.stop(evaluatorId).catch(() => undefined);
        }
      }, config.timeoutMs);
      timers.set(card.id, timer);
      void handle.done.catch(() => undefined).finally(() => {
        const pending = timers.get(card.id);
        if (pending === timer) {
          clearTimeout(timer);
          timers.delete(card.id);
        }
      });
    };

    ctx.on("board/moved", (card: BoardCard, _from: BoardColumn | null) => {
      if (card.column === "evaluating" && card.evaluatorSessionId === null) void evaluate(card);
    });

    // Cards that entered Evaluating before this plugin loaded (the provider's
    // boot pump runs in its constructor) or whose evaluator is gone.
    for (const card of ctx.board.list()) {
      if (card.column !== "evaluating") continue;
      const evaluator =
        card.evaluatorSessionId === null ? undefined : ctx.sessions.get(card.evaluatorSessionId);
      if (evaluator === undefined || !LIVE_STATUSES.includes(evaluator.status)) void evaluate(card);
    }

    ctx.tools.register(ctx, {
      name: "board_verdict",
      description: [
        "Report your decision about the card you are evaluating. Only the evaluator session of a card in Evaluating may call this; from any other session it is refused.",
        "",
        "`proceed` starts the card now. `block` parks it until every session named in `blockedBy` has finished — those must be Working sessions, by name. `defer` holds it in the queue behind the card named in `deferTo` — a card ahead of it that has not started (Queued, Evaluating or Blocked) — until that card starts or leaves the queue, then evaluates it again.",
        "",
        "Call it exactly once, at the end. Do not call it before you have looked at what the Working sessions are doing.",
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          decision: { type: "string", enum: ["proceed", "block", "defer"] },
          reason: {
            type: "string",
            description: "One sentence a person reads on the card: what you compared and why this is the answer.",
          },
          blockedBy: {
            type: "array",
            items: { type: "string" },
            description: "For `block`: names of the Working sessions this card must wait for.",
          },
          deferTo: {
            type: "string",
            description: "For `defer`: the id of a not-yet-started card ahead in the queue to wait behind.",
          },
        },
        required: ["decision", "reason"],
      },
      async execute(
        args: { decision?: unknown; reason?: unknown; blockedBy?: unknown; deferTo?: unknown },
        run: ToolRunContext,
      ) {
        const card = ctx.board.forEvaluator(run.sessionId as SessionId);
        if (card === undefined) {
          return {
            status: "refused",
            reason: "not-an-evaluator",
            detail: "this session is not evaluating any card; only evaluator sessions report verdicts",
          };
        }
        const reason = typeof args?.reason === "string" ? args.reason.trim() : "";
        if (reason.length === 0) return { status: "refused", reason: "missing-reason", detail: "`reason` is required" };
        let input: VerdictInput;
        switch (args?.decision) {
          case "proceed":
            input = { decision: "proceed", reason };
            break;
          case "block": {
            const names = Array.isArray(args.blockedBy)
              ? args.blockedBy.filter((n): n is string => typeof n === "string" && n.trim().length > 0)
              : [];
            if (names.length === 0) {
              return { status: "refused", reason: "missing-blockers", detail: "`block` needs at least one Working session name in `blockedBy`" };
            }
            input = { decision: "block", reason, blockedBy: names.map((n) => n.trim()) };
            break;
          }
          case "defer": {
            const target = typeof args.deferTo === "string" ? args.deferTo.trim() : "";
            if (target.length === 0) {
              return { status: "refused", reason: "missing-defer-target", detail: "`defer` needs the card id in `deferTo`" };
            }
            input = { decision: "defer", reason, deferTo: target };
            break;
          }
          default:
            return { status: "refused", reason: "bad-decision", detail: "`decision` must be proceed, block, or defer" };
        }
        try {
          const moved = await ctx.board.verdict(card.id, input, run.sessionId as SessionId);
          return {
            status: "recorded",
            card: moved.id,
            column: moved.column,
            ...(moved.blockedBy.length > 0 ? { blockedBy: moved.blockedBy.map((b) => b.blockerName) } : {}),
            ...(moved.sessionId !== null && moved.column === "working"
              ? { session: ctx.sessions.get(moved.sessionId)?.name ?? moved.sessionId }
              : {}),
          };
        } catch (error) {
          if (error instanceof BoardError) {
            return { status: "refused", reason: error.code, detail: error.message };
          }
          throw error;
        }
      },
    });
  },
};

export default { ...boardEvaluator, Config, settings };
