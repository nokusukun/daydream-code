import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import { z } from "zod";
import { defineConfig, field } from "@daydream-code/config";
import type { Context, Disposer } from "@daydream-code/kernel";
import type {
  JournalEvent,
  SessionRecord,
  ThreadEntry,
} from "@daydream-code/shared";
import { HttpError, type HttpMethod, type RouteRequest } from "@daydream-code/routes";
import type {} from "@daydream-code/routes";
import type {} from "@daydream-code/journal";
import { HarnessServer, type StreamMessage } from "./index.js";

export const { Config, settings } = defineConfig({
  host: field.string({
    label: "bind address",
    help: "loopback keeps the harness off the network. Change it only if you know why.",
    default: "127.0.0.1",
    placeholder: "127.0.0.1",
    restart: true,
  }),
  port: field.number({
    label: "port",
    help: "0 picks a free port at startup.",
    default: 4870,
    integer: true,
    min: 0,
    max: 65_535,
    restart: true,
  }),
  token: field.string({
    label: "bearer token",
    help: "required on every request except the health check. Unset means no auth.",
    optional: true,
    secret: true,
    restart: true,
  }),
  bodyLimit: field.number({
    label: "request limit",
    help:
      "fastify defaults to 1 MB, which a single screenshot exceeds. Sized to " +
      "clear the blob store's own cap plus base64 overhead.",
    default: 24 * 1024 * 1024,
    integer: true,
    min: 1,
    unit: "bytes",
    advanced: true,
    restart: true,
  }),
});

export type FastifyServerConfig = z.infer<typeof Config>;

/** Sockets buffering more than this are cut loose; they resync on reconnect. */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

/**
 * Methods the catch-all claims. OPTIONS is left to `@fastify/cors`, which
 * registers its own preflight route and would collide with ours. HEAD is left
 * to fastify's `exposeHeadRoutes`, which mirrors every GET — the registry
 * resolves HEAD against GET, so those land on the same handler.
 */
const METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** The slice of a `ws` WebSocket the stream needs (no @types/ws dependency). */
interface StreamSocket {
  readonly readyState: number;
  readonly OPEN: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "close", listener: () => void): void;
}

function pathOf(url: string): string {
  const query = url.indexOf("?");
  return query === -1 ? url : url.slice(0, query);
}

/** Collapse repeated query params / headers to their first value. */
function flatten(
  source: Record<string, unknown> | undefined,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source ?? {})) {
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === "string") out[key] = first;
    else if (first !== undefined && first !== null) out[key] = String(first);
  }
  return out;
}

/**
 * Default provider of the HarnessServer seam: Fastify REST + a `/stream`
 * websocket that forwards journal/thread/session events. DB-first ordering is
 * inherited from the journal — `journal/append` only fires after commit, so
 * every frame a client sees is durable.
 *
 * It serves no routes of its own. Every REST endpoint comes from `ctx.routes`,
 * which capability packages register into, and dispatch happens per request
 * rather than at bind time: fastify freezes its router once it is listening,
 * and a route plugin that loaded after boot — or unloaded when its provider
 * went away — has to take effect anyway.
 */
export default class FastifyServer extends HarnessServer {
  static inject = ["routes", "journal"];
  static Config = Config;
  static settings = settings;

  /** Resolves once the server is listening (rejects if listen fails). */
  readonly ready: Promise<void>;

  readonly #app: FastifyInstance;
  readonly #host: string;
  #port: number;

  constructor(ctx: Context, config: FastifyServerConfig) {
    super(ctx);
    this.#host = config.host;
    this.#port = config.port;

    const app = Fastify({ bodyLimit: config.bodyLimit });
    this.#app = app;

    app.setErrorHandler((error, _req, reply) => {
      const status = error instanceof HttpError ? error.status : 500;
      void reply
        .code(status)
        .send({ error: error instanceof Error ? error.message : String(error) });
    });

    const token = config.token;
    if (token !== undefined) {
      app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
        // Re-resolving the route here costs one scan of a list a dozen long,
        // and keeps one place deciding what is reachable unauthenticated.
        // `/stream` is not in the registry, so it never matches and is gated.
        const match = ctx.routes.match(req.method, pathOf(req.url));
        if (match?.route.public === true) return;
        if (req.headers.authorization === `Bearer ${token}`) return;
        if (flatten(req.query as Record<string, unknown>).token === token) return;
        return reply.code(401).send({ error: "unauthorized" });
      });
    }

    this.#mountDispatch(app);

    // Websocket routes must land after the websocket plugin; a sibling scope
    // registered afterwards inherits its onRoute hook (fastify-plugin).
    // The server binds to loopback and is bearer-token-gated; UIs load from
    // file:// or a dev origin, so allow any origin rather than none.
    void app.register(cors, { origin: true });
    void app.register(websocket);
    void app.register(async (scope) => {
      scope.get("/stream", { websocket: true }, (socket, _req) => {
        this.#streamConnection(socket as unknown as StreamSocket);
      });
    });

    let ready!: Promise<void>;
    ctx.effect(() => {
      const started = (async () => {
        await app.listen({ host: config.host, port: config.port });
        const address = app.server.address();
        if (address !== null && typeof address === "object") {
          this.#port = address.port;
        }
      })();
      ready = started;
      // Keep a rejected start from surfacing as an unhandled rejection; the
      // failure still reaches whoever awaits `ready`.
      started.catch(() => {});
      return async () => {
        await started.catch(() => {});
        await app.close();
      };
    }, "server/listen");
    this.ready = ready;
  }

  get port(): number {
    return this.#port;
  }

  get url(): string {
    return `http://${this.#host}:${this.#port}`;
  }

  // -------------------------------------------------------------------------
  // REST: one catch-all, dispatched through the route registry.

  #mountDispatch(app: FastifyInstance): void {
    const ctx = this.ctx;

    const dispatch = async (
      req: FastifyRequest,
      reply: FastifyReply,
    ): Promise<unknown> => {
      const path = pathOf(req.url);
      const match = ctx.routes.match(req.method, path);
      if (match === undefined) {
        return reply.code(404).send({ error: `not found: ${req.method} ${path}` });
      }
      const request: RouteRequest = {
        method: match.route.method,
        path,
        params: match.params,
        query: flatten(req.query as Record<string, unknown>),
        headers: flatten(req.headers as Record<string, unknown>),
        body: req.body,
      };
      const result = await match.route.handle(request);
      // A handler that returns nothing means no content; fastify would
      // otherwise reject the undefined payload and turn it into a 500.
      if (result === undefined) return reply.code(204).send();
      return result;
    };

    // Both, because "/*" does not cover the root path.
    app.route({ method: METHODS, url: "/", handler: dispatch });
    app.route({ method: METHODS, url: "/*", handler: dispatch });
  }

  // -------------------------------------------------------------------------
  // Stream

  #streamConnection(socket: StreamSocket): void {
    const send = (message: StreamMessage): void => {
      if (socket.readyState !== socket.OPEN) return;
      if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
        socket.close(1008, "client too slow; resync on reconnect");
        return;
      }
      socket.send(JSON.stringify(message));
    };

    send({ kind: "hello", lastEventId: this.ctx.journal.maxId() });

    const forwardSession = (session: SessionRecord) =>
      send({ kind: "session", session });
    const disposers: Disposer[] = [
      this.ctx.on("journal/append", (event: JournalEvent) =>
        send({ kind: "journal", event }),
      ),
      this.ctx.on("thread/append", (entry: ThreadEntry) =>
        send({ kind: "thread", entry }),
      ),
      this.ctx.on("session/updated", forwardSession),
      this.ctx.on("session/ended", forwardSession),
      this.ctx.on("session/dispatched", forwardSession),
    ];
    socket.on("close", () => {
      for (const dispose of disposers) void dispose();
    });
  }
}
