import { Service, type Context } from "@daydream-code/kernel";
import type {
  JournalEvent,
  JournalEventInput,
  SessionId,
} from "@daydream-code/shared";

declare module "@daydream-code/kernel" {
  interface Context {
    journal: Journal;
  }
  interface Events {
    /**
     * @mode emit — fired after the event is durably committed. DB-first,
     * then broadcast: a subscriber can never see an event that isn't durable.
     */
    "journal/append"(event: JournalEvent): void;
  }
}

export interface JournalReadOptions {
  sessionId?: SessionId;
  afterId?: number;
  beforeId?: number;
  types?: string[];
  limit?: number;
  /** Return the latest page instead of the earliest. */
  latest?: boolean;
}

export interface JournalSearchOptions {
  sessionId?: SessionId;
  limit?: number;
  /**
   * Hide one session's own tail: events from `sessionId` with an id at or
   * above `fromId` are dropped, while every other session is returned in
   * full.
   *
   * This exists because a tool call is journaled with its full arguments
   * before the tool runs, so the search query is inside the corpus being
   * searched — a session searching for a term it just typed matches its own
   * call, and every earlier search it made for the same term. The exclusion
   * is scoped to one session rather than applied as a global `beforeId`
   * because a sibling's event journaled a second ago is legitimate context;
   * only the caller's own in-flight step is noise.
   */
  excludeTail?: { sessionId: SessionId; fromId: number };
}

export interface JournalSearchHit {
  eventId: number;
  sessionId: SessionId;
  ts: string;
  type: string;
  snippet: string;
}

/**
 * Exclusive seam: the append-only journal. Providers must enforce
 * immutability at the storage layer (SQL triggers, not convention) and must
 * commit before emitting `journal/append`. The journal is never compacted.
 */
export abstract class Journal extends Service {
  constructor(ctx: Context) {
    super(ctx, "journal");
  }

  abstract append(input: JournalEventInput): JournalEvent;
  abstract read(options?: JournalReadOptions): JournalEvent[];
  abstract search(query: string, options?: JournalSearchOptions): JournalSearchHit[];
  abstract maxId(): number;
}
