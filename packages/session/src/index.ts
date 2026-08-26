import { Service, type Context } from "@daydream-code/kernel";
import type { SessionId, SessionRecord } from "@daydream-code/shared";
import type { Injection } from "@daydream-code/driver";

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
     *
     * `ask` is a continue whose message is machine-written: one session's
     * question, delivered by the runner. It is called out separately so the
     * master thread can say that it happened without reprinting the prose —
     * that text is addressed to one session, and broadcasting it verbatim
     * would put tool-call boilerplate in front of every other session.
     */
    "session/dispatched"(
      session: SessionRecord,
      kind: "new" | "continue" | "ask" | "message",
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
    /**
     * @mode emit — a session and its journal were purged, after the rows are
     * gone. Carries the record as it last existed, because by the time this
     * fires there is nothing left to look up: a listener that only got an id
     * could not name the thing that vanished.
     */
    "session/deleted"(session: SessionRecord): void;
  }
}

/**
 * An image on its way in: a path on disk (CLI), raw base64 (a clipboard paste
 * posted straight through), or a blob already in the store.
 *
 * The third form is what a UI uses. It uploads on paste, so the bytes cross
 * the wire once and a failed or retried send costs nothing, and so a draft can
 * hold an attachment across a reload without carrying megabytes in
 * `localStorage`. Only the id is trusted — media type and dimensions are
 * re-sniffed from the stored bytes, because dimensions price the turn.
 */
export type AttachmentInput =
  | { path: string }
  | { data: string; alt?: string | undefined }
  | { blobId: string; alt?: string | undefined };

export interface DispatchRequest {
  task: string;
  /** Images attached to the opening task. */
  attachments?: AttachmentInput[];
  /**
   * Preferred human-readable name. Slugged and de-duplicated before it lands,
   * so the stored name may differ. Omit to derive one from `task`.
   */
  name?: string;
  driver?: string;
  modelId?: string;
  permissionMode?: "auto" | "ask" | "readonly";
}

/**
 * What happened to a message handed to `deliver`.
 *
 * `queued` and `woke` are both success and are distinguished because they cost
 * the sender different things: queueing rides an existing run and is free,
 * waking spends from the target's wake budget. `refused` is the budget being
 * spent out — not an error, and the sender is expected to carry on without the
 * target rather than retry.
 */
export type DeliveryOutcome =
  | { kind: "queued" }
  | { kind: "woke" }
  | { kind: "refused"; reason: string }
  | { kind: "gone"; reason: string };

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
  abstract continueSession(
    id: SessionId,
    message: string,
    attachments?: AttachmentInput[],
  ): Promise<SessionHandle>;
  /**
   * Hand text to a session without blocking the sender: queue it into a live
   * run, or wake an idle one, whichever applies.
   *
   * This is a seam method rather than something a caller assembles out of
   * `get` + `continueSession` because the choice between those two branches is
   * exactly where the wake budget is enforced. A caller that made the choice
   * itself would spend no budget, and the cap that stops sessions restarting
   * each other unattended would hold only for the callers that remembered it.
   */
  abstract deliver(
    id: SessionId,
    text: string,
    options?: { kind?: Injection["kind"] },
  ): Promise<DeliveryOutcome>;
  abstract stop(id: SessionId): Promise<void>;
  /**
   * Shelve a finished run, or put it back.
   *
   * Live sessions are refused rather than silently allowed: the rail exists so
   * that work in flight is visible, and a shelf that can swallow a running run
   * is how a session ends up forgotten while it is still spending money.
   */
  abstract setArchived(id: SessionId, archived: boolean): SessionRecord;
  /**
   * Erase a session: its row, its thread, and its journal events.
   *
   * Deliberately a purge rather than an unlink. A session whose transcript
   * survived in the journal would still answer `search_journal` while
   * `read_session` 404s on it, which is a worse state than either keeping it
   * or removing it. Refuses a live session — stop it first.
   */
  abstract remove(id: SessionId): SessionRecord;
  abstract get(id: SessionId): SessionRecord | undefined;
  /**
   * Look a session up by id or by human-readable name. Every entry point that
   * takes a session from a human or a model should go through this.
   */
  abstract resolve(idOrName: string): SessionRecord | undefined;
  abstract list(): SessionRecord[];
  /** Sessions currently running in this process. */
  abstract running(): SessionId[];
}
