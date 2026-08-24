import { z } from "zod";
import type { Context } from "@daydream-code/kernel";
import { HttpError } from "@daydream-code/routes";
import type {} from "@daydream-code/routes";
import type {} from "./index.js";

/**
 * The settings a caller may write. Spelled out rather than derived from
 * `ProjectConfig` so adding a field to the record is not automatically an
 * admission that it is user-writable over HTTP.
 */
const ProjectConfigPatch = z
  .object({
    defaultDriver: z.string().min(1),
    /** `null` means "no pinned model"; the driver picks its own default. */
    defaultModel: z.string().min(1).nullable(),
  })
  .partial();

/** Consumer plugin: the store's HTTP surface — the project this app serves. */
const storeRoutes = {
  name: "store-routes",
  inject: ["routes", "store"],
  apply(ctx: Context) {
    ctx.routes.registerAll(ctx, [
      {
        method: "GET",
        path: "/api/project",
        handle: () => ctx.store.project,
      },
      {
        method: "PATCH",
        path: "/api/project",
        handle: (request) => {
          const parsed = ProjectConfigPatch.safeParse(request.body ?? {});
          if (!parsed.success) {
            throw new HttpError(
              400,
              parsed.error.issues
                .map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`)
                .join("; "),
            );
          }
          const { defaultDriver, defaultModel } = parsed.data;
          return ctx.store.updateConfig({
            ...(defaultDriver !== undefined ? { defaultDriver } : {}),
            ...(defaultModel !== undefined ? { defaultModel } : {}),
          });
        },
      },
    ]);
  },
};

export default storeRoutes;
