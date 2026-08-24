import type { Context } from "@daydream-code/kernel";
import type { RouteRequest } from "@daydream-code/routes";
import type {} from "./index.js";

/**
 * Consumer plugin: the master thread's HTTP surface. `?all=true` serves the
 * full history rather than the live context — compaction supersedes a prefix
 * without deleting it, so both views are always available.
 */
const threadRoutes = {
  name: "thread-routes",
  inject: ["routes", "threads"],
  apply(ctx: Context) {
    ctx.routes.register(ctx, {
      method: "GET",
      path: "/api/master",
      handle: (req: RouteRequest) => {
        const master = ctx.threads.ensureMaster();
        return req.query.all === "true"
          ? ctx.threads.entries(master.id)
          : ctx.threads.liveContext(master.id);
      },
    });
  },
};

export default threadRoutes;
