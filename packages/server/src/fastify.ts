import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import { z } from "zod";
import type { Context, Disposer } from "@daydream-code/kernel";
import {
  SessionId,
  type JournalEvent,
  type SessionRecord,
  type ThreadEntry,
} from "@daydream-code/shared";
import type { JournalReadOptions } from "@daydream-code/journal";
import type { DispatchRequest } from "@daydream-code/session";
import type {} from "@daydream-code/thread";
import type {} from "@daydream-code/store";
import { HarnessServer, type StreamMessage } from "./index.js";

export const Config = z
  .object({
    host: z.string().default("127.0.0.1"),
    port: z.number().int().min(0).max(65535).default(4870),
    token: z.string().optional(),
  })
  .prefault({});

export type FastifyServerConfig = z.infer<typeof Config>;

const DispatchBody = z.object({
  task: z.string(),
  driver: z.string().optional(),
  modelId: z.string().optional(),
  title: z.string().optional(),
});

const MessageBody = z.object({ message: z.string() });

/** Sockets buffering more than this are cut loose; they resync on reconnect. */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

/** The slice of a `ws` WebSocket the stream needs (no @types/ws dependency). */
interface StreamSocket {
  readonly readyState: number;
  readonly OPEN: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "close", listener: () => void): void;
}

type Query = Record<string, string | undefined>;

function intParam(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

/**
 * Default provider of the HarnessServer seam: Fastify REST + a `/stream`
 * websocket that forwards journal/thread/session events. DB-first ordering is
 * inherited from the journal — `journal/append` only fires after commit, so
 * every frame a client sees is durable.
 */
export default class FastifyServer extends HarnessServer {
  static inject = ["store", "journal", "threads", "sessions"];
  static Config = Config;

  /** Resolves once the server is listening (rejects if listen fails). */
  readonly ready: Promise<void>;

  readonly #app: FastifyInstance;
  readonly #host: string;
  #port: number;

  constructor(ctx: Context, config: FastifyServerConfig) {
    super(ctx);
    this.#host = config.host;
    this.#port = config.port;

    const app = Fastify();
    this.#app = app;

    app.setErrorHandler((error, _req, reply) => {
      void reply
        .code(500)
        .send({ error: error instanceof Error ? error.message : String(error) });
    });

    const token = config.token;
    if (token !== undefined) {
      app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
        if (req.routeOptions.url === "/health") return;
        if (req.headers.authorization === `Bearer ${token}`) return;
        if ((req.query as Query).token === token) return;
        return reply.code(401).send({ error: "unauthorized" });
      });
    }

    this.#restRoutes(app);

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
  // REST

  #restRoutes(app: FastifyInstance): void {
    const ctx = this.ctx;

    app.get("/health", async () => ({ ok: true }));

    app.get("/api/project", async () => ctx.store.project);

    app.get("/api/sessions", async () => ctx.sessions.list());

    app.get("/api/sessions/:id", async (req, reply) => {
      const id = SessionId((req.params as { id: string }).id);
      const session = ctx.sessions.get(id);
      if (session === undefined) {
        return reply.code(404).send({ error: `unknown session: ${id}` });
      }
      const limit = intParam((req.query as Query).limit) ?? 200;
      const journal = ctx.journal.read({ sessionId: id, limit, latest: true });
      return { session, journal };
    });

    app.post("/api/sessions", async (req) => {
      const body = DispatchBody.parse(req.body);
      const request: DispatchRequest = {
        task: body.task,
        ...(body.driver !== undefined ? { driver: body.driver } : {}),
        ...(body.modelId !== undefined ? { modelId: body.modelId } : {}),
        ...(body.title !== undefined ? { title: body.title } : {}),
      };
      const handle = await ctx.sessions.dispatch(request);
      void handle.done.catch(() => {});
      return handle.record;
    });

    app.post("/api/sessions/:id/message", async (req) => {
      const id = SessionId((req.params as { id: string }).id);
      const body = MessageBody.parse(req.body);
      const handle = await ctx.sessions.continueSession(id, body.message);
      void handle.done.catch(() => {});
      return handle.record;
    });

    app.post("/api/sessions/:id/stop", async (req) => {
      const id = SessionId((req.params as { id: string }).id);
      await ctx.sessions.stop(id);
      return { stopped: true };
    });

    app.get("/api/journal", async (req) => {
      const query = req.query as Query;
      const options: JournalReadOptions = {
        ...(query.sessionId !== undefined
          ? { sessionId: SessionId(query.sessionId) }
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
    });

    app.get("/api/journal/search", async (req) => {
      const query = req.query as Query;
      const q = query.q ?? "";
      return ctx.journal.search(q, {
        ...(query.sessionId !== undefined
          ? { sessionId: SessionId(query.sessionId) }
          : {}),
        ...(intParam(query.limit) !== undefined
          ? { limit: intParam(query.limit)! }
          : {}),
      });
    });

    app.get("/api/master", async (req) => {
      const master = ctx.threads.ensureMaster();
      const all = (req.query as Query).all === "true";
      return all ? ctx.threads.entries(master.id) : ctx.threads.liveContext(master.id);
    });

    app.get("/api/fibers", async () => ctx.registry.dumpState());
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
