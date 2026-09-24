import { z } from "zod";
import { defineConfig, field, type ConfigOf } from "@daydream-code/config";
import type { Context } from "@daydream-code/kernel";
import { HttpError, type RouteRequest } from "@daydream-code/routes";
import { LIVE_STATUSES, titleFromTask, type SessionId, type SessionRecord } from "@daydream-code/shared";
import type { DispatchRequest } from "@daydream-code/session";
import type { ToolRunContext } from "@daydream-code/tools";
import type {} from "@daydream-code/session";
import type {} from "@daydream-code/tools";
import type {} from "@daydream-code/routes";
import {
  BoardError,
  type BoardCard,
  type BoardPlan,
  type CardRequest,
} from "./index.js";

type PlannerPermission = "auto" | "ask" | "readonly";
const PERMISSION_MODES: ReadonlyArray<{ value: PlannerPermission; label: string }> = [
  { value: "auto", label: "auto" },
  { value: "ask", label: "ask" },
  { value: "readonly", label: "readonly" },
];

export const { Config, settings } = defineConfig({
  permissionMode: field.enum({
    label: "planner permissions",
    help: "the planner only reads the tree to ground its cards. readonly is a driver-level mode, and some drivers refuse git under it.",
    options: PERMISSION_MODES,
    default: "auto" as const,
  }),
});

export type PlannerConfig = ConfigOf<typeof Config>;

/** How a card looks to its planner: enough to rewrite it, with its place in line. */
function cardView(card: BoardCard, order: number) {
  return {
    id: card.id,
    order,
    title: card.title,
    task: card.task,
    // Only drafts are the planner's. Everything else is shown so it does
    // not re-add work the person already queued, and so it can say which
    // cards are no longer its to change.
    ...(card.column === "draft" ? {} : { column: card.column, locked: true }),
  };
}

function planView(ctx: Context, plan: BoardPlan) {
  const cards = ctx.board.planCards(plan.id);
  return {
    plan: plan.id,
    drafts: cards.filter((card) => card.column === "draft").length,
    cards: cards.map((card, i) => cardView(card, i + 1)),
  };
}

/** The planner's opening task. The person's words are quoted last and verbatim. */
function plannerTask(ctx: Context, prompt: string): string {
  const live = ctx.board
    .list()
    .filter((card) => card.column !== "draft" && card.column !== "done")
    .map((card) => `- [${card.column}] ${card.title}`);
  return [
    "You are the planner for a kanban board of coding sessions. The person has a large piece of work. Turn it into cards: each card becomes its own agent session once the person queues the plan.",
    "",
    "## How cards run",
    "- Every card runs as a separate session with no memory of this conversation. Its task is all it gets, so each task must stand alone: say what to change, where, why, and how to tell it is done.",
    "- All sessions share ONE working tree. The board runs cards in the order you give them, and an evaluator holds a card back while a running card would conflict with it. Put foundations (schemas, shared APIs) first. Keep cards that would edit the same files apart, or merge them.",
    "- Size each card for one focused session. Do not make one card per file, and do not make one card for the whole plan.",
    "",
    "## How to work",
    "- Read the code you need to ground the plan. Make NO edits to files. Your output is cards, not code.",
    "- Write cards with `board_plan_write`. It takes a list of changes, so a full plan is one call. `board_plan_read` shows the plan as it stands.",
    "- The person can edit, reorder and delete cards by hand between your turns. Call `board_plan_read` at the start of every later turn before changing anything.",
    "- Do not queue the plan on your own. The person reviews it first. When they reply asking you to queue it (\"looks good, queue it\"), make any last changes they asked for, then call `board_plan_queue`. It is refused until the person has replied to you at least once.",
    "- End each turn with a short message. Say what you planned and in what order, what you assumed, and anything you need the person to decide. They will reply with changes. Apply them to the cards, not just in prose.",
    "",
    "## Already on the board (do not plan these again)",
    live.length > 0 ? live.join("\n") : "(nothing queued or running)",
    "",
    "## The person's plan",
    "```",
    prompt,
    "```",
  ].join("\n");
}

/**
 * `before` for "last". A sentinel rather than null, because a JSON-Schema type
 * union is not guaranteed to survive a driver's schema conversion.
 */
const END = "end";

const Change = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("add"),
    title: z.string().optional(),
    task: z.string(),
    before: z.string().optional(),
  }),
  z.object({
    action: z.literal("update"),
    id: z.string(),
    title: z.string().optional(),
    task: z.string().optional(),
    before: z.string().optional(),
  }),
  z.object({ action: z.literal("remove"), id: z.string() }),
]);
type Change = z.infer<typeof Change>;

const PlanBody = z.object({
  prompt: z.string(),
  driver: z.string().optional(),
  modelId: z.string().optional(),
  effort: z.string().optional(),
  fastMode: z.boolean().optional(),
});

/**
 * Consumer plugin: plan mode. The person hands over a large prompt, and a
 * planner session breaks it into draft cards. The person refines those cards
 * by hand or by talking to the planner, then queues them all at once.
 *
 * The planner is a real session for the same reason the evaluator is. A good
 * plan depends on the code, and a session can go and read it. It is also a
 * thread the person already knows how to talk to: refining the plan is just
 * replying to the planner's thread. The board's continue intercept passes it
 * through, because a planner is not a card.
 *
 * Plan state lives on the board (`board_plans`, `board_cards.plan_id`), not
 * here, so a plan survives a restart and can be refined again afterwards.
 */
const boardPlanner = {
  name: "board-planner",
  inject: ["board", "sessions", "tools", "routes"] as const,
  apply(ctx: Context, config: PlannerConfig) {
    ctx.on("board/planned", (plan: BoardPlan) =>
      ctx.emit("stream/publish", { kind: "board-plan", plan }),
    );

    /** The plan behind a tool call, or the refusal to hand back instead. */
    const planOf = (run: ToolRunContext) => {
      const plan = ctx.board.planFor(run.sessionId as SessionId);
      return plan === undefined
        ? {
            refusal: {
              status: "refused",
              reason: "not-a-planner",
              detail: "this session is not planning; only a board planner writes plan cards",
            },
          }
        : { plan };
    };

    ctx.tools.register(ctx, {
      name: "board_plan_read",
      description:
        "Planner sessions only: the cards of the plan you are writing, in run order. Cards marked `locked` have been queued by the person and are no longer yours to change. Refused from any other session.",
      parameters: { type: "object", properties: {} },
      async execute(_args: unknown, run: ToolRunContext) {
        const found = planOf(run);
        return "refusal" in found ? found.refusal : planView(ctx, found.plan);
      },
    });

    ctx.tools.register(ctx, {
      name: "board_plan_write",
      description: [
        "Planner sessions only: add, rewrite, reorder or remove the draft cards of your plan. Refused from any other session.",
        "",
        "`changes` is applied in order, all or nothing: if any change is invalid, none are applied.",
        "- `add`: a new card. `task` is the full, standalone instruction the card's session will get. `title` is a short label (under ~70 characters). Omit `before` to add it at the end, or give an existing card id to insert it just above that card. Several adds with the same `before` keep their order.",
        "- `update`: change a card's `title` and/or `task`, and/or move it with `before` (a card id, or \"end\").",
        "- `remove`: delete a draft card.",
        "",
        "Returns the whole plan afterwards, so there is no need to read it again.",
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          changes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                action: { type: "string", enum: ["add", "update", "remove"] },
                id: { type: "string", description: "update/remove: the card id." },
                title: { type: "string", description: "add/update: short label for the card." },
                task: { type: "string", description: "add/update: the standalone instruction for the card's session." },
                before: {
                  type: "string",
                  description: 'add/update: place just above this card id. "end" (or omitted, for add) places it last.',
                },
              },
              required: ["action"],
            },
          },
        },
        required: ["changes"],
      },
      async execute(args: { changes?: unknown }, run: ToolRunContext) {
        const found = planOf(run);
        if ("refusal" in found) return found.refusal;
        const { plan } = found;
        const parsed = z.array(Change).safeParse(args?.changes);
        if (!parsed.success) {
          return { status: "refused", reason: "bad-changes", detail: parsed.error.message };
        }
        const changes = parsed.data;
        // Validate everything before writing anything: a plan left half-edited
        // by a change that failed halfway is harder to reason about than one
        // that did not change at all.
        const cards = new Map(ctx.board.planCards(plan.id).map((card) => [card.id, card]));
        const removed = new Set<string>();
        const problems: string[] = [];
        const draftOf = (id: string, i: number): BoardCard | undefined => {
          const card = cards.get(id);
          if (card === undefined) problems.push(`change ${i + 1}: ${id} is not a card of this plan`);
          else if (card.column !== "draft") {
            problems.push(`change ${i + 1}: ${id} is ${card.column}; the person queued it, so only they can change it now`);
          } else if (removed.has(id)) problems.push(`change ${i + 1}: ${id} was removed by an earlier change`);
          else return card;
          return undefined;
        };
        changes.forEach((change: Change, i) => {
          if (change.action === "add") {
            if (change.task.trim().length === 0) problems.push(`change ${i + 1}: \`task\` is empty`);
            if (change.before !== undefined && change.before !== END) draftOf(change.before, i);
            return;
          }
          const card = draftOf(change.id, i);
          if (card === undefined) return;
          if (change.action === "remove") {
            removed.add(card.id);
            return;
          }
          if (change.task !== undefined && change.task.trim().length === 0) {
            problems.push(`change ${i + 1}: \`task\` is empty`);
          }
          if (change.before !== undefined && change.before !== END) draftOf(change.before, i);
        });
        if (problems.length > 0) {
          return { status: "refused", reason: "invalid-changes", detail: problems.join("; "), ...planView(ctx, plan) };
        }

        try {
          for (const change of changes) {
            if (change.action === "add") {
              const card = ctx.board.create({
                task: change.task.trim(),
                ...(change.title !== undefined ? { title: change.title } : {}),
                request: plan.request,
                planId: plan.id,
              });
              // A new card is already at the end.
              if (change.before !== undefined && change.before !== END) ctx.board.reorder(card.id, change.before);
            } else if (change.action === "update") {
              if (change.task !== undefined || change.title !== undefined) {
                ctx.board.update(change.id, {
                  ...(change.task !== undefined ? { task: change.task.trim() } : {}),
                  ...(change.title !== undefined ? { title: change.title } : {}),
                });
              }
              if (change.before !== undefined) {
                ctx.board.reorder(change.id, change.before === END ? null : change.before);
              }
            } else {
              ctx.board.cancel(change.id);
            }
          }
        } catch (error) {
          // A person's hand can still beat validation: they queued a card
          // between the check and the write. Say what stands now.
          if (error instanceof BoardError) {
            return { status: "partial", detail: error.message, ...planView(ctx, plan) };
          }
          throw error;
        }
        return { status: "applied", ...planView(ctx, plan) };
      },
    });

    /**
     * Plans whose person has replied to the planner at least once. Queuing
     * is the one planner move that starts agents, so it waits for the person
     * to have seen a draft. The planner's first run is always refused, even
     * when the prompt said "and queue it". In memory only, which fails safe:
     * after a restart the planner waits for the next reply, and that reply is
     * the one asking it to queue.
     */
    const heard = new Set<string>();
    ctx.on(
      "session/dispatched",
      (session: SessionRecord, kind: string, _message: string, causedBy: readonly SessionId[]) => {
        // A person's message is a plain continue that nothing else caused.
        // Sibling asks and relayed messages have their own kinds.
        if (kind !== "continue" || causedBy.length > 0) return;
        const plan = ctx.board.planFor(session.id);
        if (plan !== undefined) heard.add(plan.id);
      },
    );

    ctx.tools.register(ctx, {
      name: "board_plan_queue",
      description:
        "Planner sessions only: queue every draft of your plan, in plan order, at the back of the board's queue. The cards then start as the evaluator clears them. Call it only when the person has asked you to queue the plan. It is refused until the person has replied to you at least once. Refused from any other session.",
      parameters: { type: "object", properties: {} },
      async execute(_args: unknown, run: ToolRunContext) {
        const found = planOf(run);
        if ("refusal" in found) return found.refusal;
        const { plan } = found;
        if (!heard.has(plan.id)) {
          return {
            status: "refused",
            reason: "not-reviewed",
            detail:
              "the person has not replied since you drafted this plan. End your turn with a summary of the plan. They can ask you to queue it, or use the Queue button.",
          };
        }
        const queued = ctx.board.submitPlan(plan.id);
        if (queued.length === 0) {
          return { status: "refused", reason: "nothing-to-queue", detail: "the plan has no drafts left", ...planView(ctx, plan) };
        }
        return { status: "queued", cards: queued.map((card) => ({ id: card.id, title: card.title, column: card.column })) };
      },
    });

    const planOr404 = (id: string): BoardPlan => {
      const plan = ctx.board.getPlan(id);
      if (plan === undefined) throw new HttpError(404, `unknown plan: ${id}`);
      return plan;
    };

    ctx.routes.registerAll(ctx, [
      { method: "GET", path: "/api/board/plans", handle: () => ctx.board.listPlans() },
      {
        method: "POST",
        path: "/api/board/plans",
        handle: async (req: RouteRequest) => {
          const body = PlanBody.parse(req.body);
          const prompt = body.prompt.trim();
          if (prompt.length === 0) throw new HttpError(400, "a plan needs a prompt");
          // One agent for both: the person picks who plans, and that choice
          // also runs the cards unless they change a card by hand.
          const agent: CardRequest = {
            ...(body.driver !== undefined ? { driver: body.driver } : {}),
            ...(body.modelId !== undefined ? { modelId: body.modelId } : {}),
            ...(body.effort !== undefined ? { effort: body.effort } : {}),
            ...(body.fastMode !== undefined ? { fastMode: body.fastMode } : {}),
          };
          const request: DispatchRequest = {
            task: plannerTask(ctx, prompt),
            name: `plan ${titleFromTask(prompt, 40)}`,
            permissionMode: config.permissionMode,
            ...agent,
          };
          const { plan, handle } = await ctx.board.beginPlan({
            title: titleFromTask(prompt),
            planner: request,
            cards: agent,
          });
          void handle.done.catch(() => undefined);
          return plan;
        },
      },
      {
        method: "POST",
        path: "/api/board/plans/:id/submit",
        handle: (req: RouteRequest) => {
          planOr404(req.params.id!);
          return ctx.board.submitPlan(req.params.id!);
        },
      },
      {
        method: "DELETE",
        path: "/api/board/plans/:id",
        handle: (req: RouteRequest) => {
          const plan = planOr404(req.params.id!);
          const removed = ctx.board.discardPlan(plan.id);
          // A planner still writing would put cards back into a plan the
          // person just threw away.
          const planner = plan.sessionId === null ? undefined : ctx.sessions.get(plan.sessionId);
          if (planner !== undefined && LIVE_STATUSES.includes(planner.status)) {
            void ctx.sessions.stop(planner.id).catch(() => undefined);
          }
          return removed;
        },
      },
    ]);
  },
};

export default { ...boardPlanner, Config, settings };
