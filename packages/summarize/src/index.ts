import { Service, type Context } from "@daydream-code/kernel";
import type { JournalEvent, SessionRecord } from "@daydream-code/shared";

declare module "@daydream-code/kernel" {
  interface Context {
    summarizer: Summarizer;
  }
}

export interface TurnSummaryInput {
  session: SessionRecord;
  /** Journal events of the turn just finished. */
  turnEvents: JournalEvent[];
}

export interface SessionSummaryInput {
  session: SessionRecord;
  /** Full journal of the session, oldest first. */
  events: JournalEvent[];
  /** Why the session ended. */
  reason: "completed" | "failed" | "killed";
}

/**
 * Exclusive seam: summaries written back to the master thread. Facts stay
 * exact (names, paths, numbers, promises); interpretations stay weak — a
 * wrong confident memory poisons every future fork.
 */
export abstract class Summarizer extends Service {
  constructor(ctx: Context) {
    super(ctx, "summarizer");
  }

  /** One line for `session <id> turn end, summary: ...`. */
  abstract turnSummary(input: TurnSummaryInput): Promise<string>;
  /** Final write-back: structured summary + tldr. */
  abstract sessionSummary(
    input: SessionSummaryInput,
  ): Promise<{ summary: string; tldr: string }>;
}
