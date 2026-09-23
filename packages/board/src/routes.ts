import { z } from "zod";
import type { Context } from "@daydream-code/kernel";
import { HttpError, type RouteRequest } from "@daydream-code/routes";
import type { SessionId } from "@daydream-code/shared";
import type {} from "@daydream-code/session";
import { BoardError, type BoardCard, type CardRequest } from "./index.js";

const AttachmentBody = z.union([
  z.object({ path: z.string() }),
  z.object({ data: z.string(), alt: z.string().optional() }),
  z.object({ blobId: z.string(), alt: z.string().optional() }),
]);

const RequestBody = z.object({
  driver: z.string().optional(),
  modelId: z.string().optional(),
  effort: z.string().optional(),
  fastMode: z.boolean().optional(),
  name: z.string().optional(),
  attachments: z.array(AttachmentBody).optional(),
  permissionMode: z.enum(["auto", "ask", "readonly"]).optional(),
});

const CreateBody = RequestBody.extend({
  task: z.string(),
  draft: z.boolean().optional(),
});

const PatchBody = z.object({
  task: z.string().optional(),
  request: RequestBody.optional(),
});

const ReorderBody = z.object({ before: z.string().nullable() });

const BlockersBody = z.object({
  /** Session names or ids; each must belong to a Working card. */
  sessions: z.array(z.string()),
  reason: z.string().optional(),
});

function requestOf(body: z.infer<typeof RequestBody>): CardRequest {
  return {
    ...(body.driver !== undefined ? { driver: body.driver } : {}),
    ...(body.modelId !== undefined ? { modelId: body.modelId } : {}),
    ...(body.effort !== undefined ? { effort: body.effort } : {}),
    ...(body.fastMode !== undefined ? { fastMode: body.fastMode } : {}),
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.attachments !== undefined ? { attachments: body.attachments } : {}),
    ...(body.permissionMode !== undefined ? { permissionMode: body.permissionMode } : {}),
  };
}

/** A refused board operation, as a status a client can act on. */
function status(error: unknown): never {
  if (error instanceof BoardError) {
    switch (error.code) {
      case "not-found":
        throw new HttpError(404, error.message);
      case "bad-blocker":
      case "bad-defer":
        throw new HttpError(400, error.message);
      default:
        throw new HttpError(409, error.message);
    }
  }
  throw error;
}

/**
 * HTTP surface of the board, and its frames on the stream. Absent entirely
 * when the board row is off, which is how a client learns the project is not
 * in kanban mode: `GET /api/board` 404s.
 */
const boardRoutes = {
  name: "board-routes",
  inject: ["routes", "board", "sessions"] as const,
  apply(ctx: Context) {
    ctx.on("board/moved", (card: BoardCard) => ctx.emit("stream/publish", { kind: "board", card }));
    ctx.on("board/removed", (card: BoardCard) =>
      ctx.emit("stream/publish", { kind: "board-removed", id: card.id }),
    );

    const attempt = <T>(run: () => T): T => {
      try {
        return run();
      } catch (error) {
        return status(error);
      }
    };

    ctx.routes.registerAll(ctx, [
      {
        method: "GET",
        path: "/api/board",
        handle: () => ({ enabled: true, cards: ctx.board.list() }),
      },
      {
        method: "GET",
        path: "/api/board/cards/:id",
        handle: (req: RouteRequest) => {
          const card = ctx.board.get(req.params.id!);
          if (card === undefined) throw new HttpError(404, `unknown card: ${req.params.id}`);
          return card;
        },
      },
      {
        method: "POST",
        path: "/api/board/cards",
        handle: (req: RouteRequest) => {
          const body = CreateBody.parse(req.body);
          return attempt(() =>
            ctx.board.create({
              task: body.task,
              request: requestOf(body),
              ...(body.draft !== undefined ? { draft: body.draft } : {}),
            }),
          );
        },
      },
      {
        method: "PATCH",
        path: "/api/board/cards/:id",
        handle: (req: RouteRequest) => {
          const body = PatchBody.parse(req.body);
          return attempt(() =>
            ctx.board.update(req.params.id!, {
              ...(body.task !== undefined ? { task: body.task } : {}),
              ...(body.request !== undefined ? { request: requestOf(body.request) } : {}),
            }),
          );
        },
      },
      {
        method: "POST",
        path: "/api/board/cards/:id/submit",
        handle: (req: RouteRequest) => attempt(() => ctx.board.submit(req.params.id!)),
      },
      {
        method: "POST",
        path: "/api/board/cards/:id/reorder",
        handle: (req: RouteRequest) => {
          const body = ReorderBody.parse(req.body);
          return attempt(() => ctx.board.reorder(req.params.id!, body.before));
        },
      },
      {
        method: "POST",
        path: "/api/board/cards/:id/start",
        handle: async (req: RouteRequest) => {
          try {
            return await ctx.board.start(req.params.id!);
          } catch (error) {
            return status(error);
          }
        },
      },
      {
        method: "PUT",
        path: "/api/board/cards/:id/blockers",
        handle: (req: RouteRequest) => {
          const body = BlockersBody.parse(req.body);
          const blockers = body.sessions.map((key) => {
            const session = ctx.sessions.resolve(key);
            if (session === undefined) throw new HttpError(400, `unknown session: ${key}`);
            return {
              sessionId: session.id as SessionId,
              ...(body.reason !== undefined ? { reason: body.reason } : {}),
            };
          });
          return attempt(() => ctx.board.setBlockers(req.params.id!, blockers));
        },
      },
      {
        method: "DELETE",
        path: "/api/board/cards/:id",
        handle: (req: RouteRequest) => attempt(() => ctx.board.cancel(req.params.id!)),
      },
    ]);
  },
};

export default boardRoutes;
