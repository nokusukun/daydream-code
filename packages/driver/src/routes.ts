import type { Context } from "@daydream-code/kernel";
import type {} from "@daydream-code/routes";
import type {} from "./index.js";

/**
 * Consumer plugin: the driver registry's HTTP surface — every mounted
 * driver's selectable models, which is what a composer's model picker lists.
 */
const driverRoutes = {
  name: "driver-routes",
  inject: ["routes", "drivers"],
  apply(ctx: Context) {
    ctx.routes.register(ctx, {
      method: "GET",
      path: "/api/models",
      handle: () => ctx.drivers.catalog(),
    });
  },
};

export default driverRoutes;
