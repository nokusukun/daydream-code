import type { Context } from "@daydream-code/kernel";
import { HttpError, type RouteRequest } from "@daydream-code/routes";
import { WorkspacePathError } from "./index.js";
import type {} from "./index.js";

/**
 * Consumer plugin: the workspace's HTTP surface. Reads only — the seam has no
 * write path, so neither does this.
 *
 * `path` is a query parameter rather than a `:param` segment because the
 * values are project-relative paths with their own slashes, and the router
 * matches segment by segment. One encoded query value is the honest shape.
 */
const workspaceRoutes = {
  name: "workspace-routes",
  inject: ["routes", "workspace"],
  apply(ctx: Context) {
    /** Path errors are the caller's fault, not a 500. */
    const guard = async <T>(work: () => Promise<T>): Promise<T> => {
      try {
        return await work();
      } catch (error) {
        if (error instanceof WorkspacePathError) {
          throw new HttpError(404, error.message);
        }
        throw error;
      }
    };

    const required = (req: RouteRequest, key: string): string => {
      const value = req.query[key];
      if (value === undefined || value.length === 0) {
        throw new HttpError(400, `missing "${key}" query parameter`);
      }
      return value;
    };

    ctx.routes.registerAll(ctx, [
      {
        method: "GET",
        path: "/api/workspace",
        handle: () => ctx.workspace.status(),
      },
      {
        method: "GET",
        path: "/api/workspace/tree",
        handle: (req: RouteRequest) =>
          guard(() => ctx.workspace.tree(req.query.path ?? "")),
      },
      {
        // Content and diff in one response: the editor needs both to draw a
        // single line, and two round trips would let it paint the file once
        // and then reflow it as the marks arrive.
        method: "GET",
        path: "/api/workspace/file",
        handle: (req: RouteRequest) =>
          guard(async () => {
            const target = required(req, "path");
            const [file, diff] = await Promise.all([
              ctx.workspace.read(target),
              ctx.workspace.diff(target),
            ]);
            return { ...file, diff };
          }),
      },
      {
        method: "GET",
        path: "/api/workspace/diff",
        handle: (req: RouteRequest) =>
          guard(() => ctx.workspace.diff(required(req, "path"))),
      },
    ]);
  },
};

export default workspaceRoutes;
