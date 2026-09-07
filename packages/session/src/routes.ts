import { z } from "zod";
import type { Context } from "@daydream-code/kernel";
import { HttpError, intParam, type RouteRequest } from "@daydream-code/routes";
import type { SessionRecord } from "@daydream-code/shared";
import type { QuestionOutcome } from "@daydream-code/questions";
import type {} from "@daydream-code/questions";
import type {} from "@daydream-code/journal";
import type { DispatchRequest } from "./index.js";
import type {} from "./index.js";
import { lastEditableMessage } from "./transcript.js";

/**
 * An attachment arrives as a path (the caller shares this machine's disk), as
 * base64 (a clipboard paste posted in one shot), or as a blob id from
 * `POST /api/blobs` — which is the form a composer uses, having uploaded the
 * bytes when they were pasted rather than when the message was sent.
 */
const AttachmentBody = z.union([
  z.object({ path: z.string() }),
  z.object({ data: z.string(), alt: z.string().optional() }),
  z.object({ blobId: z.string(), alt: z.string().optional() }),
]);

const DispatchBody = z.object({
  task: z.string(),
  driver: z.string().optional(),
  modelId: z.string().optional(),
  effort: z.string().optional(),
  fastMode: z.boolean().optional(),
  name: z.string().optional(),
  attachments: z.array(AttachmentBody).optional(),
});

const MessageBody = z.object({
  message: z.string(),
  attachments: z.array(AttachmentBody).optional(),
});

const CheckpointBody = MessageBody.extend({
  fromEventId: z.number().int().positive(),
});

/**
 * Shelve or restore. Explicit rather than a toggle: a client that retried a
 * toggle would flip the run back, and the caller always knows which state it
 * wants.
 */
const ArchiveBody = z.object({ archived: z.boolean() });

/**
 * A mid-thread agent switch. Partial on purpose — absent means "keep",
 * explicit null means "back to the driver's default" — which is why the two
 * nullable fields are `.nullable().optional()` rather than plain optional.
 */
const ModelBody = z.object({
  driver: z.string().optional(),
  modelId: z.string().nullable().optional(),
  effort: z.string().nullable().optional(),
  fastMode: z.boolean().optional(),
});

const HandoffBody = z.object({
  mode: z.enum(["transcript", "summary"]),
  task: z.string().optional(),
  driver: z.string().optional(),
  modelId: z.string().optional(),
  effort: z.string().optional(),
  fastMode: z.boolean().optional(),
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
 * dispatch, continue, checkpoint, stop, archive, delete, answer.
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
          return {
            session,
            journal,
            nextMessages: ctx.sessions.nextMessages(session.id),
            editableMessage: lastEditableMessage(
              ctx.journal.read({
                sessionId: session.id,
                types: [
                  "session_started",
                  "user_message_queued",
                  "user_injected",
                  "session_checkpoint",
                ],
              }),
            ),
          };
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
            ...(body.effort !== undefined ? { effort: body.effort } : {}),
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
        path: "/api/sessions/:id/checkpoint",
        handle: async (req: RouteRequest) => {
          const session = resolve(req);
          const body = CheckpointBody.parse(req.body);
          try {
            const handle = await ctx.sessions.checkpointSession(
              session.id,
              body.fromEventId,
              body.message,
              body.attachments,
            );
            void handle.done.catch(() => {});
            return handle.record;
          } catch (error) {
            throw new HttpError(409, String((error as Error).message ?? error));
          }
        },
      },
      {
        method: "POST",
        path: "/api/sessions/:id/next-messages",
        handle: (req: RouteRequest) => {
          const session = resolve(req);
          const body = MessageBody.parse(req.body);
          try {
            return ctx.sessions.enqueueNextMessage(
              session.id,
              body.message,
              body.attachments,
            );
          } catch (error) {
            throw new HttpError(409, String((error as Error).message ?? error));
          }
        },
      },
      {
        method: "POST",
        path: "/api/sessions/:id/next-messages/:deliveryId/edit",
        handle: (req: RouteRequest) => {
          try {
            return ctx.sessions.beginNextMessageEdit(
              resolve(req).id,
              req.params.deliveryId!,
            );
          } catch (error) {
            throw new HttpError(409, String((error as Error).message ?? error));
          }
        },
      },
      {
        method: "PUT",
        path: "/api/sessions/:id/next-messages/:deliveryId",
        handle: (req: RouteRequest) => {
          const body = MessageBody.parse(req.body);
          try {
            return ctx.sessions.updateNextMessage(
              resolve(req).id,
              req.params.deliveryId!,
              body.message,
              body.attachments,
            );
          } catch (error) {
            throw new HttpError(409, String((error as Error).message ?? error));
          }
        },
      },
      {
        method: "POST",
        path: "/api/sessions/:id/next-messages/:deliveryId/edit/cancel",
        handle: (req: RouteRequest) => {
          try {
            return ctx.sessions.cancelNextMessageEdit(
              resolve(req).id,
              req.params.deliveryId!,
            );
          } catch (error) {
            throw new HttpError(409, String((error as Error).message ?? error));
          }
        },
      },
      {
        method: "DELETE",
        path: "/api/sessions/:id/next-messages/:deliveryId",
        handle: (req: RouteRequest) => ({
          cancelled: ctx.sessions.cancelNextMessage(
            resolve(req).id,
            req.params.deliveryId!,
          ),
        }),
      },
      {
        method: "POST",
        path: "/api/sessions/:id/model",
        handle: (req: RouteRequest) => {
          const session = resolve(req);
          const body = ModelBody.parse(req.body);
          // 409 for a live thread (same shape as archive/delete: well-formed
          // request, busy run, remedy is to wait or stop) and for an unknown
          // driver — both come out of the seam as refusals.
          try {
            return ctx.sessions.setModel(session.id, {
              ...(body.driver !== undefined ? { driver: body.driver } : {}),
              ...(body.modelId !== undefined ? { modelId: body.modelId } : {}),
              ...(body.effort !== undefined ? { effort: body.effort } : {}),
            });
          } catch (error) {
            throw new HttpError(409, String((error as Error).message ?? error));
          }
        },
      },
      {
        method: "POST",
        path: "/api/sessions/:id/model/undo",
        handle: (req: RouteRequest) => {
          const session = resolve(req);
          try {
            return ctx.sessions.undoModelChange(session.id);
          } catch (error) {
            throw new HttpError(409, String((error as Error).message ?? error));
          }
        },
      },
      {
        method: "POST",
        path: "/api/sessions/:id/handoff",
        handle: async (req: RouteRequest) => {
          const session = resolve(req);
          const body = HandoffBody.parse(req.body);
          const handle = await ctx.sessions.handoff(session.id, {
            mode: body.mode,
            ...(body.task !== undefined ? { task: body.task } : {}),
            ...(body.driver !== undefined ? { driver: body.driver } : {}),
            ...(body.modelId !== undefined ? { modelId: body.modelId } : {}),
            ...(body.effort !== undefined ? { effort: body.effort } : {}),
          });
          // The caller gets the new record now; the run outlives the request.
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
        path: "/api/sessions/:id/archive",
        handle: (req: RouteRequest) => {
          const session = resolve(req);
          const body = ArchiveBody.parse(req.body);
          // A live session is refused by the seam, not here. 409 rather than
          // 400: the request is well formed, the run is simply busy, and the
          // caller's remedy is to stop it and retry.
          try {
            return ctx.sessions.setArchived(session.id, body.archived);
          } catch (error) {
            throw new HttpError(409, String((error as Error).message ?? error));
          }
        },
      },
      {
        method: "DELETE",
        path: "/api/sessions/:id",
        handle: (req: RouteRequest) => {
          const session = resolve(req);
          try {
            return ctx.sessions.remove(session.id);
          } catch (error) {
            throw new HttpError(409, String((error as Error).message ?? error));
          }
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
