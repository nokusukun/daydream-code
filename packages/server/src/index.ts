import { Service, type Context } from "@daydream-code/kernel";
import type {
  JournalEvent,
  SessionRecord,
  ThreadEntry,
} from "@daydream-code/shared";

declare module "@daydream-code/kernel" {
  interface Context {
    server: HarnessServer;
  }
}

// ---------------------------------------------------------------------------
// Wire protocol

/**
 * Frames sent over the `/stream` websocket. `hello` arrives first with the
 * journal's max id at connect time — a client that reconnects can diff against
 * its own cursor and backfill via `GET /api/journal?afterId=...`.
 */
export type StreamMessage =
  | { kind: "hello"; lastEventId: number }
  | { kind: "journal"; event: JournalEvent }
  | { kind: "thread"; entry: ThreadEntry }
  | { kind: "session"; session: SessionRecord };

// ---------------------------------------------------------------------------
// Seam

/**
 * Exclusive seam: the transport that carries the harness's HTTP/WS surface.
 *
 * It owns binding and framing, not endpoints — REST routes come from
 * `ctx.routes`, which every capability package registers into, so replacing
 * this provider swaps the transport without moving a single route. The default
 * (server-fastify) serves those routes plus a websocket event stream.
 */
export abstract class HarnessServer extends Service {
  constructor(ctx: Context) {
    super(ctx, "server");
  }

  /** The bound port (real port once listening, even when configured as 0). */
  abstract readonly port: number;
  /** Base URL of the bound server, e.g. `http://127.0.0.1:4870`. */
  abstract readonly url: string;
}
