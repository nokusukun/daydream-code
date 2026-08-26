import { z } from "zod";
import type { Context } from "@daydream-code/kernel";
import { HttpError, type RouteRequest } from "@daydream-code/routes";
import { QuickActionError } from "./index.js";
import type {} from "./index.js";

const AddBody = z.object({
  command: z.string(),
  label: z.string().optional(),
});

const PatchBody = z.object({
  command: z.string().optional(),
  label: z.string().optional(),
});

/**
 * Consumer plugin: the quick-action list's HTTP surface.
 *
 * The desktop toolbar is the only client today, and it reads on every open
 * rather than holding a copy: the list changes when a session adds to it, and
 * a menu that showed a stale list would be showing the person a command that
 * is no longer offered — or hiding one that is.
 */
const actionRoutes = {
  name: "action-routes",
  inject: ["routes", "actions"],
  apply(ctx: Context) {
    /** Bounds are the seam's; a caller's mistake is a 400, not a 500. */
    const guard = <T>(run: () => T): T => {
      try {
        return run();
      } catch (error) {
        if (error instanceof QuickActionError) {
          throw new HttpError(400, error.message);
        }
        throw error;
      }
    };

    ctx.routes.registerAll(ctx, [
      {
        method: "GET",
        path: "/api/actions",
        handle: () => ctx.actions.list(),
      },
      {
        method: "POST",
        path: "/api/actions",
        handle: (req: RouteRequest) => {
          const body = AddBody.parse(req.body);
          // No `source` on the wire: this endpoint is the person's, and a
          // client that could name itself could put a session's name on a row
          // the person typed, which is the one thing provenance must not lie
          // about. A session adds through the tool instead.
          return guard(() =>
            ctx.actions.add({
              command: body.command,
              ...(body.label !== undefined ? { label: body.label } : {}),
            }),
          );
        },
      },
      {
        method: "PATCH",
        path: "/api/actions/:id",
        handle: (req: RouteRequest) => {
          const body = PatchBody.parse(req.body);
          const id = req.params.id!;
          const next = guard(() =>
            ctx.actions.update(id, {
              ...(body.label !== undefined ? { label: body.label } : {}),
              ...(body.command !== undefined ? { command: body.command } : {}),
            }),
          );
          // Undefined covers both "no such row" and "you emptied its command,
          // so it is gone now". Either way there is nothing to return, and the
          // client's next read is the truth.
          if (next === undefined) throw new HttpError(404, `no quick action: ${id}`);
          return next;
        },
      },
      {
        method: "DELETE",
        path: "/api/actions/:id",
        handle: (req: RouteRequest) => {
          const id = req.params.id!;
          if (!ctx.actions.remove(id)) {
            throw new HttpError(404, `no quick action: ${id}`);
          }
          return { ok: true };
        },
      },
    ]);
  },
};

export default actionRoutes;
