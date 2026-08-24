import type { Context } from "@daydream-code/kernel";
import { AskRefused, type AskOutcome } from "@daydream-code/asks";
import { SessionId, LIVE_STATUSES } from "@daydream-code/shared";
import { schema } from "@daydream-code/store";
import { and, eq } from "@daydream-code/store/drizzle";
import type {} from "./index.js";
import type {} from "@daydream-code/asks";
import type {} from "@daydream-code/store";

/** A question the model can usefully wait on has to be answerable in prose. */
const MAX_QUESTION = 2000;

interface TargetRow {
  id: string;
  name: string;
  status: string;
}

/**
 * Consumer plugin: `ask_session` / `answer_session`, the pair that lets one
 * session put a question to another and block until it comes back.
 *
 * The target is resolved against the sessions table directly, the way
 * `recall.ts` does, because `session` depends on this package and the reverse
 * import would be a build cycle. Unlike that resolver this one does *not* fall
 * back to treating an unmatched string as an id: a typo there would hand the
 * asks seam a session that does not exist and park the caller against nobody
 * until its reminders ran out. A bad name fails immediately with the list of
 * real ones instead.
 */
const askSessionTools = {
  name: "ask-session-tools",
  inject: ["tools", "asks", "store"],
  apply(ctx: Context) {
    const projectId = () => ctx.store.project.id;

    const findSession = (idOrName: string): TargetRow | undefined =>
      ctx.store.db
        .select({
          id: schema.sessions.id,
          name: schema.sessions.name,
          status: schema.sessions.status,
        })
        .from(schema.sessions)
        .where(
          and(
            eq(schema.sessions.projectId, projectId()),
            eq(schema.sessions.name, idOrName),
          ),
        )
        .get() ??
      ctx.store.db
        .select({
          id: schema.sessions.id,
          name: schema.sessions.name,
          status: schema.sessions.status,
        })
        .from(schema.sessions)
        .where(
          and(
            eq(schema.sessions.projectId, projectId()),
            eq(schema.sessions.id, idOrName),
          ),
        )
        .get();

    const nameOf = (id: SessionId): string =>
      ctx.store.db
        .select({ name: schema.sessions.name })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, id))
        .get()?.name ?? id;

    /** Live sessions, for the error message when a name does not resolve. */
    const reachable = (): string[] =>
      ctx.store.db
        .select({ name: schema.sessions.name, status: schema.sessions.status })
        .from(schema.sessions)
        .where(eq(schema.sessions.projectId, projectId()))
        .all()
        .filter((row) => LIVE_STATUSES.includes(row.status as never))
        .map((row) => row.name);

    /** Render an outcome as the thing the asking model should do next. */
    const describe = (toName: string, outcome: AskOutcome) => {
      switch (outcome.kind) {
        case "answered":
          return {
            status: "answered",
            from: toName,
            answer: outcome.text,
          };
        case "declined":
          return {
            status: "declined",
            from: toName,
            reason: outcome.reason,
            guidance: `${toName} declined to answer. Decide it yourself and record the assumption in your summary — do not ask again.`,
          };
        case "unanswered":
          return {
            status: "unanswered",
            from: toName,
            reason: outcome.reason,
            nudges: outcome.nudges,
            guidance: `${toName} was reminded ${outcome.nudges} time(s) and never answered. Proceed on your best judgement and say in your summary that you assumed it. Do not re-ask the same session — post_to_master if it still needs to know.`,
          };
        case "cancelled":
          return {
            status: "cancelled",
            reason: outcome.reason,
            guidance:
              "Your own run is ending; the answer is not coming. Do not ask again this turn.",
          };
      }
    };

    ctx.tools.register(ctx, {
      name: "ask_session",
      description: [
        "Ask another session in this project a question and wait for its answer. Your turn blocks until it replies, declines, or ignores you long enough to give up, so ask only what is worth stopping for.",
        "",
        "Use this when a sibling knows something you cannot find out yourself: what it decided and why, whether it is done with a file you need, whether a change you are about to make would break its work. Do not use it for things the repository can answer — read the code — or for things only the user can decide, which is what ask_user is for.",
        "",
        "Do not use it to announce something. If the other session does not need to answer, post_to_master is free and does not block anyone. This costs the other session a turn.",
        "",
        "The target is woken if it is idle and reminded if it stays quiet. If it never answers you are released with `unanswered` and must proceed on your own judgement.",
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          session: {
            type: "string",
            description:
              "Name (or id) of the session to ask, as it appears on the master thread.",
          },
          question: {
            type: "string",
            description:
              "The full question. The other session sees only this text and its own context, so include what it needs to answer without guessing what you are working on.",
          },
        },
        required: ["session", "question"],
      },
      async execute(args: { session?: string; question?: string }, run) {
        const target = typeof args?.session === "string" ? args.session.trim() : "";
        const question =
          typeof args?.question === "string" ? args.question.trim() : "";
        if (!target) throw new Error("`session` is required");
        if (!question) throw new Error("`question` is required");
        if (question.length > MAX_QUESTION) {
          throw new Error(
            `question is ${question.length} chars; keep it under ${MAX_QUESTION}. Link to a file or a journal hit instead of pasting context.`,
          );
        }
        const row = findSession(target);
        if (!row) {
          const live = reachable();
          return {
            status: "refused",
            reason: "unknown-session",
            detail: `no session named "${target}" in this project`,
            reachable: live,
            guidance:
              live.length > 0
                ? "Use one of the names in `reachable`, exactly as written."
                : "There are no other live sessions to ask. Decide it yourself.",
          };
        }
        try {
          const outcome = await ctx.asks.ask({
            fromSessionId: run.sessionId,
            fromName: nameOf(run.sessionId),
            toSessionId: SessionId(row.id),
            toName: row.name,
            question,
          });
          return describe(row.name, outcome);
        } catch (error) {
          // A refusal never blocked anyone, so it comes back as a result the
          // model can act on rather than a tool error it has to interpret.
          if (error instanceof AskRefused) {
            return {
              status: "refused",
              reason: error.refusal.reason,
              detail: error.refusal.detail,
              guidance:
                error.refusal.reason === "cycle"
                  ? "You and that session would be waiting on each other. Post to the master thread instead, or decide without it."
                  : "Nothing is blocked. Proceed, or ask a different session.",
            };
          }
          throw error;
        }
      },
    });

    ctx.tools.register(ctx, {
      name: "answer_session",
      description: [
        "Answer a question another session asked you with ask_session. That session is stopped until you do, so answer before you resume your own work.",
        "",
        "Answer from what you actually know. If you do not know, say so with decline rather than guessing — a wrong answer is worse for them than no answer, because they cannot tell the difference.",
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          answer: {
            type: "string",
            description:
              "Your answer, or — when declining — why you cannot answer.",
          },
          request_id: {
            type: "string",
            description:
              "Which question, from the ask you were sent. Omit to answer the oldest one still waiting on you.",
          },
          decline: {
            type: "boolean",
            description:
              "True if you cannot answer. Use `answer` to say why so they can proceed knowingly.",
          },
        },
        required: ["answer"],
      },
      async execute(
        args: { answer?: string; request_id?: string; decline?: boolean },
        run,
      ) {
        const text = typeof args?.answer === "string" ? args.answer.trim() : "";
        if (!text) {
          throw new Error(
            "`answer` is required — give the answer, or the reason you are declining.",
          );
        }
        const waiting = ctx.asks.inbound(run.sessionId);
        const requestId = args?.request_id?.trim() || waiting[0]?.requestId;
        if (!requestId) {
          return {
            status: "nothing-to-answer",
            guidance:
              "No session is waiting on you. If you meant to tell someone something, use post_to_master.",
          };
        }
        const outcome: AskOutcome =
          args?.decline === true
            ? { kind: "declined", reason: text }
            : { kind: "answered", text };
        const result = ctx.asks.answer(requestId, run.sessionId, outcome);
        switch (result) {
          case "settled":
            return {
              status: "sent",
              requestId,
              remaining: ctx.asks.inbound(run.sessionId).length,
            };
          case "not-yours":
            // Answering for someone else would be indistinguishable from the
            // real thing at the far end, so it is refused rather than allowed.
            return {
              status: "refused",
              reason: "that question was not addressed to you",
              guidance:
                "Only the session that was asked can answer. Omit request_id to answer the oldest question waiting on you.",
            };
          case "unknown":
            return {
              status: "expired",
              guidance:
                "That question is no longer waiting — it was answered, given up on, or its asker ended. Carry on with your own work.",
            };
        }
      },
    });
  },
};

export default askSessionTools;
