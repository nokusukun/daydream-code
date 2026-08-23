import { Service, type Context } from "@daydream-code/kernel";
import type { ThreadId } from "@daydream-code/shared";

declare module "@daydream-code/kernel" {
  interface Context {
    compaction: Compactor;
  }
  interface Events {
    /** @mode emit — after a compaction entry is appended. */
    "compaction/done"(result: CompactionResult): void;
  }
}

export interface CompactionResult {
  threadId: ThreadId;
  tier: 1 | 2;
  supersededThroughSeq: number;
  compactedEntries: number;
  summaryChars: number;
}

/**
 * Exclusive seam: master-thread compaction. Copy-on-write only — providers
 * append a `compaction` entry with supersedesThroughSeq and never delete.
 * Tier 1: collapse a completed session's dispatch/turn-end chatter into its
 * final summary (mechanical). Tier 2: model-driven summarization of the
 * oldest stretch when the live context exceeds the project budget.
 */
export abstract class Compactor extends Service {
  constructor(ctx: Context) {
    super(ctx, "compaction");
  }

  /** Check the thread against budget and compact if needed. Never throws. */
  abstract maybeCompact(threadId: ThreadId): Promise<CompactionResult[]>;
}
