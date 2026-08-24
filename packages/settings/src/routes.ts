import { z } from "zod";
import type { Context } from "@daydream-code/kernel";
import { HttpError } from "@daydream-code/routes";
import type {} from "@daydream-code/routes";
import type {} from "./index.js";

const WriteBody = z.object({
  layer: z.enum(["user", "project"]),
  id: z.string().min(1),
  set: z
    .object({
      name: z.string().min(1),
      config: z.unknown(),
      disabled: z.boolean(),
      isolate: z.array(z.string()),
    })
    .partial()
    .optional(),
  unset: z.array(z.enum(["name", "config", "disabled", "isolate"])).optional(),
  apply: z.boolean().optional(),
});

/**
 * Consumer plugin: the settings surface over HTTP.
 *
 * Registered into the route registry rather than added to a transport, so the
 * settings window works against whatever transport is mounted — and so these
 * routes come and go with this plugin, which matters more here than elsewhere:
 * turning the settings API off should actually turn it off.
 */
const configRoutes = {
  name: "config-routes",
  inject: ["routes", "settings"],
  apply(ctx: Context) {
    ctx.routes.registerAll(ctx, [
      {
        method: "GET",
        path: "/api/settings",
        handle: () => ctx.settings.view(),
      },
      {
        method: "POST",
        path: "/api/settings",
        handle: async (request) => {
          const parsed = WriteBody.safeParse(request.body ?? {});
          if (!parsed.success) {
            throw new HttpError(
              400,
              parsed.error.issues
                .map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`)
                .join("; "),
            );
          }
          const { set, unset, layer, id, apply } = parsed.data;
          // Rebuilt key by key rather than spread: `exactOptionalPropertyTypes`
          // treats a present-but-undefined key as a real value, and here that
          // would read as "unset the module specifier".
          const fields =
            set === undefined
              ? undefined
              : {
                  ...(set.name !== undefined ? { name: set.name } : {}),
                  ...("config" in set ? { config: set.config } : {}),
                  ...(set.disabled !== undefined ? { disabled: set.disabled } : {}),
                  ...(set.isolate !== undefined ? { isolate: set.isolate } : {}),
                };
          try {
            return await ctx.settings.write({
              layer,
              id,
              ...(apply !== undefined ? { apply } : {}),
              ...(fields !== undefined ? { set: fields } : {}),
              ...(unset !== undefined ? { unset } : {}),
            });
          } catch (error) {
            // A malformed layer file or an unwritable path is the caller's
            // problem to see, not a 500 with the detail swallowed.
            throw new HttpError(400, error instanceof Error ? error.message : String(error));
          }
        },
      },
      {
        method: "POST",
        path: "/api/settings/apply",
        handle: () => ctx.settings.apply(),
      },
    ]);
  },
};

export default configRoutes;
