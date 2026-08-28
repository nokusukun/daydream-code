import type { Context } from "@daydream-code/kernel";
import { HttpError } from "@daydream-code/routes";
import type {} from "./index.js";

interface StoreContext {
  store: { rootPath: string };
}

/**
 * Consumer plugin: the driver registry's HTTP surface — every mounted
 * driver's selectable models, which is what a composer's model picker lists.
 */
const driverRoutes = {
  name: "driver-routes",
  inject: ["routes", "drivers", "store"],
  apply(ctx: Context) {
    ctx.routes.registerAll(ctx, [
      {
        method: "GET",
        path: "/api/models",
        handle: () => ctx.drivers.catalog(),
      },
      {
        method: "GET",
        path: "/api/skills",
        handle: (request) => {
          const driver = request.query.driver;
          if (driver === undefined || driver.length === 0) {
            throw new HttpError(400, "driver is required");
          }
          // The runtime injection guarantees this capability. Keeping the
          // structural type local avoids making the driver registry depend on
          // the SQLite store package just to read its project root.
          const rootPath = (ctx as Context & StoreContext).store.rootPath;
          return ctx.drivers.skills(driver, rootPath);
        },
      },
    ]);
  },
};

export default driverRoutes;
