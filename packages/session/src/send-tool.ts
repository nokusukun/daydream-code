import type { Context } from "@daydream-code/kernel";
import { LIVE_STATUSES, type SessionId } from "@daydream-code/shared";
import type {} from "@daydream-code/tools";
import type {} from "@daydream-code/journal";
import type {} from "./index.js";

/** Long enough to say something useful, short enough not to be a handoff. */
const MAX_MESSAGE = 2000;

/**
 * Consumer plugin: `send_session`, the non-blocking half of sibling contact.
 *
 * This lives in `packages/session` rather than in `packages/tools` because it
 * needs `ctx.sessions`, and `session` already depends on `tools` — the reverse
 * import is the build cycle that makes `recall.ts` resolve names against the
 * store by hand. Depending downhill costs nothing here.
 *
 * The three ways to reach a sibling are deliberately distinct, and the
 * descriptions below are what keeps a model from reaching for the expensive
 * one by default:
 *
 * - `post_to_master` — broadcast. Nobody is woken, nobody owes a reply.
 * - `send_session`   — addressed. The target is woken if idle, owes nothing.
 * - `ask_session`    — addressed, and the sender blocks until it answers.
 */
const sendTools = {
  name: "send-tools",
  inject: ["tools", "sessions", "journal"],
  apply(ctx: Context) {
    const nameOf = (id: SessionId): string => ctx.sessions.get(id)?.name ?? id;

    const reachable = (): string[] =>
      ctx.sessions
        .list()
        .filter((s) => LIVE_STATUSES.includes(s.status))
        .map((s) => s.name);

    ctx.tools.register(ctx, {
      name: "send_session",
      description: [
        "Send a message to another session in this project without waiting for a reply. If it is idle it is woken to read this; if it is mid-turn the message arrives at its next step. Your own turn continues either way.",
        "",
        "Use this to tell a sibling something it needs to know but does not have to answer: that you have taken a file it was about to edit, that a decision it is relying on changed, that you finished the thing it was blocked on.",
        "",
        "If you need an answer before you can continue, use ask_session instead — this tool does not deliver one back. If nobody in particular needs to know, post_to_master is cheaper and wakes no one.",
        "",
        "This cannot redirect work already underway. The message is read at the target's next step, alongside whatever it is already doing; it does not interrupt or replace its current task.",
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          session: {
            type: "string",
            description:
              "Name (or id) of the session to reach, as it appears on the master thread. Use list_sessions to see who is live.",
          },
          message: {
            type: "string",
            description:
              "What you want it to know. It sees only this text and its own context, so say which files or decisions you mean rather than assuming it can see your work.",
          },
        },
        required: ["session", "message"],
      },
      async execute(args: { session?: string; message?: string }, run) {
        const target =
          typeof args?.session === "string" ? args.session.trim() : "";
        const message =
          typeof args?.message === "string" ? args.message.trim() : "";
        if (!target) throw new Error("`session` is required");
        if (!message) throw new Error("`message` is required");
        if (message.length > MAX_MESSAGE) {
          throw new Error(
            `message is ${message.length} chars; keep it under ${MAX_MESSAGE}. Point at a file or a journal hit instead of pasting context.`,
          );
        }

        const record = ctx.sessions.resolve(target);
        if (!record) {
          const live = reachable();
          return {
            status: "refused",
            reason: "unknown-session",
            detail: `no session named "${target}" in this project`,
            reachable: live,
          };
        }
        if (record.id === run.sessionId) {
          return {
            status: "refused",
            reason: "self",
            detail: "a session cannot send to itself",
          };
        }

        const from = nameOf(run.sessionId);
        const text = [
          `[message from session ${from}]`,
          "",
          message,
          "",
          "No reply is required — this is a notification, not a question. Carry on with your own work; if it changes what you were doing, say so in your summary.",
        ].join("\n");

        const outcome = await ctx.sessions.deliver(record.id, text);
        ctx.journal.append({
          sessionId: record.id,
          type: "message_received",
          payload: { from, message, delivery: outcome.kind },
        });

        switch (outcome.kind) {
          case "queued":
            return {
              status: "delivered",
              to: record.name,
              detail:
                record.status === "waiting"
                  ? `${record.name} is blocked on a question of its own; your message is queued and reaches it once that clears.`
                  : `${record.name} is mid-turn; your message reaches it at its next step.`,
            };
          case "woke":
            return {
              status: "delivered",
              to: record.name,
              detail: `${record.name} was idle and has been woken to read this.`,
            };
          case "refused":
            return {
              status: "not-delivered",
              to: record.name,
              reason: outcome.reason,
              guidance:
                "It has been woken enough times without the user speaking to it. Use post_to_master instead — it reaches the session without starting a run.",
            };
          case "gone":
            return {
              status: "not-delivered",
              to: record.name,
              reason: outcome.reason,
            };
        }
      },
    });
  },
};

export default sendTools;
