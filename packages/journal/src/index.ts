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
  abstract search(query: string, options?: { sessionId?: SessionId; limit?: number }): JournalSearchHit[];
  abstract maxId(): number;
}
