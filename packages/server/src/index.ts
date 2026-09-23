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
  | { kind: "session"; session: SessionRecord }
  /**
   * A session was deleted. Its own frame rather than a `session` frame with a
   * tombstone field, because every client merges `session` frames by upsert —
   * a removal that arrived on that channel would be quietly re-added to the
   * list it was meant to leave.
   */
  | { kind: "session-deleted"; id: string };

/**
 * A frame the transport did not define. Capabilities publish these through
 * `stream/publish`; the client learns their shape from the capability, not
 * from here.
 */
export interface ExtensionFrame {
  kind: string;
}

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

// ---------------------------------------------------------------------------
// Publishing from outside the transport

declare module "@daydream-code/kernel" {
  interface Events {
    /**
     * @mode emit — push one frame to every open `/stream` socket.
     *
     * The transport forwards a fixed set of core events on its own; a
     * capability that wants its own frames on the wire emits this rather than
     * the server learning what a board or a ticket is. The frame's `kind` is
     * the contract with the client, and must not collide with the core kinds
     * in `StreamMessage`.
     */
    "stream/publish"(message: StreamMessage | ExtensionFrame): void;
  }
}
