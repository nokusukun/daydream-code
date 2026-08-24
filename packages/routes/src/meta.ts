import type { Context } from "@daydream-code/kernel";
import type {} from "./index.js";

/**
 * Consumer plugin: the two routes that describe the harness itself rather than
 * any capability in it. They ship here because they need nothing but the
 * kernel — putting them in a transport would make them one transport's
 * routes, and every replacement would have to reimplement liveness.
 */
const metaRoutes = {
  name: "meta-routes",
  inject: ["routes"],
  apply(ctx: Context) {
    ctx.routes.registerAll(ctx, [
      {
        method: "GET",
        path: "/health",
        // The one unauthenticated route: a caller that cannot present a token
        // still has to be able to find out whether anything is listening.
        public: true,
        handle: () => ({ ok: true }),
      },
      {
        method: "GET",
        path: "/api/fibers",
        handle: () => ctx.registry.dumpState(),
      },
    ]);
  },
};

export default metaRoutes;
