import { Service, type Context } from "@daydream-code/kernel";
import type { SessionId, SessionRecord } from "@daydream-code/shared";

declare module "@daydream-code/kernel" {
  interface Context {
    sessions: Sessions;
  }
  interface Events {
    /**
     * @mode waterfall — around a dispatch; listeners may veto by returning
     * without next(), or transform the request.
     */
    "session/pre-dispatch"(
      request: DispatchRequest,
      next: (request?: DispatchRequest) => Promise<SessionRecord>,
    ): Promise<SessionRecord>;
    /** @mode emit — after a session's status row changes. */
    "session/updated"(session: SessionRecord): void;
    /**
     * @mode emit — a session was dispatched (new) or continued. Fired after
     * the row exists; master-writeback turns this into a master-thread entry.
     */
    "session/dispatched"(
      session: SessionRecord,
      kind: "new" | "continue",
      message: string,
    ): void;
    /** @mode emit — a turn finished; `summary` is the one-liner for master. */
    "session/turn-ended"(session: SessionRecord, summary: string): void;
    /**
     * @mode emit — cooperative collection: listeners push text blocks to be
     * injected into the session's next turn (e.g. `[master thread update]`).
     */
    "session/collect-injections"(
      session: SessionRecord,
      blocks: string[],
    ): void;
    /** @mode emit — session reached a terminal status, after final write-back row update. */
    "session/ended"(session: SessionRecord): void;
  }
}

export interface DispatchRequest {
  task: string;
  title?: string;
  driver?: string;
  modelId?: string;
  permissionMode?: "auto" | "ask" | "readonly";
}

export interface SessionHandle {
  record: SessionRecord;
  /** Resolves when the session's run loop finishes (any status). */
  done: Promise<SessionRecord>;
}

/**
 * Exclusive seam: the session lifecycle. The default provider (session-runner)
 * implements dispatch = fork master + drive + journal + write back; a
 * different provider can replace the whole loop.
 */
export abstract class Sessions extends Service {
  constructor(ctx: Context) {
    super(ctx, "sessions");
  }

  abstract dispatch(request: DispatchRequest): Promise<SessionHandle>;
  /** Send a message into a session; restarts the loop if it already ended. */
  abstract continueSession(id: SessionId, message: string): Promise<SessionHandle>;
  abstract stop(id: SessionId): Promise<void>;
  abstract get(id: SessionId): SessionRecord | undefined;
  abstract list(): SessionRecord[];
  /** Sessions currently running in this process. */
  abstract running(): SessionId[];
}
