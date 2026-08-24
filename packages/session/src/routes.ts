import { z } from "zod";
import type { Context } from "@daydream-code/kernel";
import { HttpError, intParam, type RouteRequest } from "@daydream-code/routes";
import type { SessionRecord } from "@daydream-code/shared";
import type { QuestionOutcome } from "@daydream-code/questions";
import type {} from "@daydream-code/questions";
import type {} from "@daydream-code/journal";
import type { DispatchRequest } from "./index.js";
import type {} from "./index.js";

/**
 * An attachment arrives either as a path (the desktop app runs on the same
 * machine, and Electron hands a dropped file a real path) or as base64 (a
 * clipboard paste, which has no path).
 */
const AttachmentBody = z.union([
  z.object({ path: z.string() }),
  z.object({ data: z.string(), alt: z.string().optional() }),
]);

const DispatchBody = z.object({
  task: z.string(),
  driver: z.string().optional(),
  modelId: z.string().optional(),
  name: z.string().optional(),
  attachments: z.array(AttachmentBody).optional(),
});

const MessageBody = z.object({
  message: z.string(),
  attachments: z.array(AttachmentBody).optional(),
});

/**
 * An answer to a blocking question. `answers` maps question id (which is the
 * question text) to the chosen label, or labels for a multi-select. `decline`
 * hands the decision back to the model instead — the explicit alternative to
 * a silent timeout, which this harness deliberately does not have.
 */
const AnswerBody = z.object({
  requestId: z.string().optional(),
  answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
  decline: z.boolean().optional(),
});

/**
 * Consumer plugin: the session lifecycle's HTTP surface — list, read,
 * dispatch, continue, stop, answer.
 *
 * Answering a question lands here rather than on the questions package's own
 * routes because it has to resolve `:id` through the sessions seam first, and
 * questions is a dependency of this package, not the other way round.
 */
const sessionRoutes = {
  name: "session-routes",
  inject: ["routes", "sessions", "journal", "questions"],
  apply(ctx: Context) {
    /** Every `:id` accepts a name, since master-thread prose names sessions. */
    const resolve = (req: RouteRequest): SessionRecord => {
      const key = req.params.id!;
      const session = ctx.sessions.resolve(key);
      if (session === undefined) {
        throw new HttpError(404, `unknown session: ${key}`);
      }
      return session;
    };

    ctx.routes.registerAll(ctx, [
      {
        method: "GET",
        path: "/api/sessions",
        handle: () => ctx.sessions.list(),
      },
      {
        method: "GET",
        path: "/api/sessions/:id",
        handle: (req: RouteRequest) => {
          const session = resolve(req);
          const journal = ctx.journal.read({
            sessionId: session.id,
            limit: intParam(req.query.limit) ?? 200,
            latest: true,
          });
          return { session, journal };
        },
      },
      {
        method: "POST",
        path: "/api/sessions",
        handle: async (req: RouteRequest) => {
          const body = DispatchBody.parse(req.body);
          const request: DispatchRequest = {
            task: body.task,
            ...(body.driver !== undefined ? { driver: body.driver } : {}),
            ...(body.modelId !== undefined ? { modelId: body.modelId } : {}),
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.attachments !== undefined
              ? { attachments: body.attachments }
              : {}),
          };
          const handle = await ctx.sessions.dispatch(request);
          // The caller gets the record now; the run outlives the request.
          void handle.done.catch(() => {});
          return handle.record;
        },
      },
      {
        method: "POST",
        path: "/api/sessions/:id/message",
        handle: async (req: RouteRequest) => {
          const session = resolve(req);
          const body = MessageBody.parse(req.body);
          const handle = await ctx.sessions.continueSession(
            session.id,
            body.message,
            body.attachments,
          );
          void handle.done.catch(() => {});
          return handle.record;
        },
      },
      {
        method: "POST",
        path: "/api/sessions/:id/stop",
        handle: async (req: RouteRequest) => {
          await ctx.sessions.stop(resolve(req).id);
          return { stopped: true };
        },
      },
      {
        method: "POST",
        path: "/api/sessions/:id/answer",
        handle: (req: RouteRequest) => {
          const session = resolve(req);
          const body = AnswerBody.parse(req.body);
          if (!body.decline && Object.keys(body.answers ?? {}).length === 0) {
            throw new HttpError(
              400,
              "provide `answers`, or `decline: true` to hand the decision back",
            );
          }
          const outcome: QuestionOutcome = body.decline
            ? { kind: "declined" }
            : { kind: "answered", answers: body.answers ?? {} };
          // A requestId that no longer resolves is the normal shape of a late
          // answer — the process that held the promise is gone, and nothing can
          // ever settle it. Report that rather than pretending it landed, so the
          // client can retire the question instead of leaving it pinned.
          const settled = body.requestId
            ? ctx.questions.settle(body.requestId, outcome)
            : ctx.questions.settleCurrent(session.id, outcome);
          if (!settled) {
            throw new HttpError(
              409,
              "no pending question to answer; it was already settled or its process restarted",
            );
          }
          return { settled: true };
        },
      },
    ]);
  },
};

export default sessionRoutes;
