import type { Context } from "@daydream-code/kernel";
import type { RouteRequest } from "@daydream-code/routes";
import { SessionId } from "@daydream-code/shared";
import type {} from "./index.js";

/**
 * Just enough of the sessions seam to turn a name into an id. Read through
 * `ctx.get` rather than injected and typed: `@daydream-code/session` depends
 * on this package, so importing it back would be a build cycle. With no
 * session seam mounted the query param is taken as a raw id.
 */
interface SessionResolver {
  resolve(idOrName: string): { id: string } | undefined;
}

/**
 * Consumer plugin: the pending-question list.
 *
 * Answering lives on the session routes instead, because settling a question
 * needs the session resolved first and this package cannot see that seam. The
 * split follows the dependency direction rather than the URL prefix.
 */
const questionRoutes = {
  name: "question-routes",
  inject: ["routes", "questions"],
  apply(ctx: Context) {
    ctx.routes.register(ctx, {
      method: "GET",
      path: "/api/questions",
      handle: (req: RouteRequest) => {
        const key = req.query.sessionId;
        if (key === undefined) return ctx.questions.pending();
        const resolved = ctx.get<SessionResolver>("sessions")?.resolve(key);
        return ctx.questions.pending(SessionId(resolved?.id ?? key));
      },
    });
  },
};

export default questionRoutes;
