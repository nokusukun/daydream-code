import type { Context } from "@daydream-code/kernel";
import { intParam, type RouteRequest } from "@daydream-code/routes";
import { SessionId } from "@daydream-code/shared";
import type { JournalReadOptions } from "./index.js";
import type {} from "./index.js";

/**
 * Just enough of the sessions seam to turn a name into an id.
 *
 * Read through `ctx.get` rather than injected and typed, because
 * `@daydream-code/session` depends on this package — importing it back would
 * be a build cycle. The lookup is genuinely optional too: with no session seam
 * mounted, a `sessionId` query param is simply taken as the id it looks like.
 */
interface SessionResolver {
  resolve(idOrName: string): { id: string } | undefined;
}

/**
 * Consumer plugin: the journal's HTTP surface. Reads and search only — the
 * journal is append-only, and the one thing that writes to it is a running
 * session.
 */
const journalRoutes = {
  name: "journal-routes",
  inject: ["routes", "journal"],
  apply(ctx: Context) {
    /** Query params may carry a name; fall through to the raw value as an id. */
    const resolveSessionId = (key: string): SessionId =>
      SessionId(ctx.get<SessionResolver>("sessions")?.resolve(key)?.id ?? key);

    ctx.routes.registerAll(ctx, [
      {
        method: "GET",
        path: "/api/journal",
        handle: (req: RouteRequest) => {
          const { query } = req;
          const options: JournalReadOptions = {
            ...(query.sessionId !== undefined
              ? { sessionId: resolveSessionId(query.sessionId) }
              : {}),
            ...(intParam(query.afterId) !== undefined
              ? { afterId: intParam(query.afterId)! }
              : {}),
            ...(intParam(query.limit) !== undefined
              ? { limit: intParam(query.limit)! }
              : {}),
            ...(query.latest === "true" ? { latest: true } : {}),
          };
          return ctx.journal.read(options);
        },
      },
      {
        method: "GET",
        path: "/api/journal/search",
        handle: (req: RouteRequest) => {
          const { query } = req;
          return ctx.journal.search(query.q ?? "", {
            ...(query.sessionId !== undefined
              ? { sessionId: resolveSessionId(query.sessionId) }
              : {}),
            ...(intParam(query.limit) !== undefined
              ? { limit: intParam(query.limit)! }
              : {}),
          });
        },
      },
    ]);
  },
};

export default journalRoutes;
