import { z } from "zod";
import type { Context } from "@daydream-code/kernel";
import type {
  ModelMessage,
  SessionId,
  ThreadEntry,
  ThreadId,
} from "@daydream-code/shared";
import type { Threads } from "@daydream-code/thread";
import type { TokenEstimator } from "@daydream-code/tokens";
import { Compactor, type CompactionResult } from "./index.js";

export const COMPACTION_HEADER =
  "[memory compaction] The following replaces all earlier master-thread entries:";

const Config = z
  .object({
    budgetTokens: z.number().default(50_000),
    keepTokens: z.number().default(10_000),
  })
  .prefault({});

type ConfigOut = z.infer<typeof Config>;

/**
 * Two-tier copy-on-write compactor. Tier 1 (in-cut): a completed session's
 * dispatch/turn-end chatter collapses into its `session_summary`, kept
 * verbatim. Tier 2: the oldest stretch of the master thread is folded into a
 * single mechanical digest under the token budget. Facts exact — nothing in
 * the summary is generated, only copied. (The `tier: 1` result value is
 * reserved for a future standalone tier-1 pass; this provider reports its
 * combined pass as tier 2.)
 */
export default class TwoTierCompactor extends Compactor {
  static inject = ["threads", "tokens"];
  static Config = Config;

  readonly #config: ConfigOut;

  constructor(ctx: Context, config: ConfigOut) {
    super(ctx);
    this.#config = config;
  }

  async maybeCompact(threadId: ThreadId): Promise<CompactionResult[]> {
    try {
      return this.#compact(threadId);
    } catch (error) {
      console.error("[compaction/two-tier] maybeCompact failed:", error);
      return [];
    }
  }

  #compact(threadId: ThreadId): CompactionResult[] {
    const threads: Threads = this.ctx.threads;
    const tokens: TokenEstimator = this.ctx.tokens;
    const { budgetTokens, keepTokens } = this.#config;

    const live = threads.liveContext(threadId);
    const total = tokens.estimateEntries(live);
    if (total <= budgetTokens) return [];

    // Only entries of this thread may be superseded. liveContext can include
    // fork-parent-chain entries; those belong to the parent and are never cut.
    const own = live.filter((e) => e.threadId === threadId);
    if (own.length === 0) return [];

    const cost = (e: ThreadEntry): number =>
      e.tokenEstimate || tokens.estimateMessage(e.message);

    // Smallest prefix of own entries whose removal brings the remaining live
    // window (including uncuttable parent entries) down to keepTokens.
    let cut = 0;
    let remaining = total;
    while (cut < own.length && remaining > keepTokens) {
      remaining -= cost(own[cut]!);
      cut += 1;
    }
    if (cut === 0) return [];

    // Never end the cut between a session's dispatch/turn_end run and its
    // session_summary when the summary is inside the live window: prefer
    // extending the cut through the summary.
    const summaryAt = new Map<SessionId, number>();
    own.forEach((e, i) => {
      if (e.kind === "session_summary" && e.sessionId !== undefined) {
        summaryAt.set(e.sessionId, i);
      }
    });
    for (let extended = true; extended; ) {
      extended = false;
      for (let i = 0; i < cut; i++) {
        const e = own[i]!;
        if (
          (e.kind === "session_dispatch" || e.kind === "session_turn_end") &&
          e.sessionId !== undefined
        ) {
          const at = summaryAt.get(e.sessionId);
          if (at !== undefined && at >= cut) {
            cut = at + 1;
            extended = true;
          }
        }
      }
    }

    const cutEntries = own.slice(0, cut);

    // Sessions fully covered by the cut: their summary stands in for the run.
    const summarized = new Set<SessionId>();
    for (const e of cutEntries) {
      if (e.kind === "session_summary" && e.sessionId !== undefined) {
        summarized.add(e.sessionId);
      }
    }

    // Sessions with chatter in the cut but no summary in the live window are
    // still running: they get one line, emitted at their last chatter entry.
    const lastChatterAt = new Map<SessionId, number>();
    cutEntries.forEach((e, i) => {
      if (
        (e.kind === "session_dispatch" || e.kind === "session_turn_end") &&
        e.sessionId !== undefined &&
        !summarized.has(e.sessionId)
      ) {
        lastChatterAt.set(e.sessionId, i);
      }
    });

    const lines: string[] = [];
    cutEntries.forEach((e, i) => {
      switch (e.kind) {
        case "session_summary":
          // Tier 1: the summary survives VERBATIM; its chatter is dropped.
          lines.push(messageText(e.message));
          break;
        case "session_dispatch":
        case "session_turn_end": {
          const sessionId = e.sessionId;
          if (sessionId === undefined) break;
          if (summarized.has(sessionId)) break; // collapsed into the summary
          if (lastChatterAt.get(sessionId) !== i) break;
          let text = "";
          for (let j = i; j >= 0; j--) {
            const prior = cutEntries[j]!;
            if (prior.sessionId === sessionId && prior.kind === "session_turn_end") {
              text = messageText(prior.message);
              break;
            }
          }
          if (text === "") text = messageText(e.message); // dispatch only, no turns yet
          lines.push(`session ${sessionId} in progress: ${truncate(text, 300)}`);
          break;
        }
        case "compaction": {
          // A prior compaction digest: keep its facts verbatim, drop its header.
          let text = messageText(e.message);
          if (text.startsWith(COMPACTION_HEADER)) {
            text = text.slice(COMPACTION_HEADER.length).replace(/^\r?\n/, "");
          }
          if (text.length > 0) lines.push(text);
          break;
        }
        default:
          // Loose entries: message / note / session_message — verbatim, capped.
          lines.push(truncate(messageText(e.message), 300));
      }
    });

    const supersededThroughSeq = cutEntries[cutEntries.length - 1]!.seq;
    const summary = [COMPACTION_HEADER, ...lines].join("\n");
    const message: ModelMessage = { role: "user", content: summary };
    threads.append({
      threadId,
      kind: "compaction",
      supersedesThroughSeq: supersededThroughSeq,
      message,
      tokenEstimate: tokens.estimateMessage(message),
    });

    const result: CompactionResult = {
      threadId,
      tier: 2,
      supersededThroughSeq,
      compactedEntries: cutEntries.length,
      summaryChars: summary.length,
    };
    this.ctx.emit("compaction/done", result);
    return [result];
  }
}

function messageText(message: ModelMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) =>
      part.type === "text" || part.type === "marker" ? part.text : `[${part.type}]`,
    )
    .join("\n");
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}
