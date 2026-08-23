import { Service, type Context } from "@daydream-code/kernel";
import type {
  ModelMessage,
  Thread,
  ThreadEntry,
  ThreadEntryInput,
  ThreadId,
} from "@daydream-code/shared";

declare module "@daydream-code/kernel" {
  interface Context {
    threads: Threads;
  }
  interface Events {
    /** @mode emit — fired after an entry is durably appended. */
    "thread/append"(entry: ThreadEntry): void;
  }
}

export interface EntryRange {
  fromSeq?: number;
  toSeq?: number;
  limit?: number;
}

/**
 * Exclusive seam: thread storage. Threads are append-only — compaction is
 * copy-on-write (a `compaction` entry with `supersedesThroughSeq`), never a
 * DELETE, so forks below any cut and full-history reads keep working.
 */
export abstract class Threads extends Service {
  constructor(ctx: Context) {
    super(ctx, "threads");
  }

  /** The project's master thread, created on first call. */
  abstract ensureMaster(): Thread;
  /** Fork: a session thread referencing the parent snapshot by seq. */
  abstract fork(from: ThreadId, atSeq?: number): Thread;
  abstract get(id: ThreadId): Thread | undefined;
  /** Append with a transactionally-assigned per-thread seq. Emits thread/append. */
  abstract append(input: ThreadEntryInput): ThreadEntry;
  /** Raw entries of one thread (no fork resolution, no compaction folding). */
  abstract entries(id: ThreadId, range?: EntryRange): ThreadEntry[];
  abstract maxSeq(id: ThreadId): number;

  /**
   * The context a model should see for this thread:
   * - resolves the fork chain (parent entries up to forkedAtSeq, recursively),
   * - folds compaction: newest applicable compaction entry replaces everything
   *   it supersedes.
   */
  abstract liveContext(id: ThreadId): ThreadEntry[];

  /** Convenience: as ModelMessages, oldest first. */
  liveMessages(id: ThreadId): ModelMessage[] {
    return this.liveContext(id).map((entry) => entry.message);
  }
}
