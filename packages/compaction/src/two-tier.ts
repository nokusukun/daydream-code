import { z } from "zod";
import { defineConfig, field } from "@daydream-code/config";
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

/** Rendered when the digest cannot carry every fact it covers. */
/** Most of the target that the verbatim tail may claim; the rest is the digest's. */
const MAX_KEEP_SHARE = 0.75;

export const ELISION = (n: number): string =>
  `[… ${n} earlier ${n === 1 ? "entry" : "entries"} elided]`;

const { Config, settings } = defineConfig({
  budgetTokens: field.number({
    label: "context budget",
    help: "the master thread is compacted once its live context passes this.",
    default: 50_000,
    min: 0,
    unit: "tokens",
  }),
  targetTokens: field.number({
    label: "compact down to",
    help: "the size a compaction pass aims to leave the live context at. Must be under the budget, or it is clamped to it.",
    default: 30_000,
    min: 0,
    unit: "tokens",
  }),
  keepTokens: field.number({
    label: "verbatim tail",
    help: "the most recent stretch, never folded into a digest. Comes out of the target; whatever is left over is the digest's own budget.",
    default: 10_000,
    min: 0,
    unit: "tokens",
  }),
});

export { Config, settings };

type ConfigOut = z.infer<typeof Config>;

/**
 * Two-tier copy-on-write compactor. Tier 1 (in-cut): a completed session's
 * dispatch/turn-end chatter collapses into its `session_summary`. Tier 2: the
 * oldest stretch of the master thread is folded into a single mechanical
 * digest. Facts are copied, never generated.
 *
 * The digest is *budgeted*, which is the whole reason this converges. An
 * unbounded digest copies its summaries verbatim and comes out roughly the
 * size of what it replaced, so the live context never drops under the budget
 * and every turn-end appends another same-size digest forever — measured on
 * this project's own master thread before the budget existed: a 20k-token
 * thread compacted to a 20,811-token digest and then re-fired on every pass,
 * growing storage by one row each time while `liveContext` never moved.
 *
 * Truncating in the digest is safe in a way it would not be elsewhere: the
 * thread is append-only, so `entries()` and the `?all=true` route still serve
 * every superseded row verbatim, and each session's own transcript is intact.
 * The digest is a working set, not the record.
 */
export default class TwoTierCompactor extends Compactor {
  static inject = ["threads", "tokens"];
  static Config = Config;
  static settings = settings;

  readonly #config: ConfigOut;

  constructor(ctx: Context, config: ConfigOut) {
    super(ctx);
    this.#config = config;
  }

  /**
   * The thresholds actually in force, after clamping. Config fields validate
   * independently, so nothing stops `targetTokens` being set above
   * `budgetTokens` or `keepTokens` swallowing the whole target. Clamping
   * rather than rejecting keeps a nonsensical pair from failing the fiber and
   * taking compaction offline altogether — a thread that stops compacting is
   * a worse outcome than one that compacts on adjusted numbers, and `budget()`
   * reports what it actually used.
   */
  budget(): {
    budgetTokens: number;
    targetTokens: number;
    keepTokens: number;
    digestTokens: number;
  } {
    const budgetTokens = this.#config.budgetTokens;
    const targetTokens = Math.min(this.#config.targetTokens, budgetTokens);
    // The digest keeps a floor share of the target. Without it, keep == target
    // leaves the digest nothing and an entire prefix — hundreds of entries —
    // renders as a bare elision marker, which reads as data loss even though
    // the rows are all still there.
    const keepTokens = Math.min(
      this.#config.keepTokens,
      Math.floor(targetTokens * MAX_KEEP_SHARE),
    );
    return {
      budgetTokens,
      targetTokens,
      keepTokens,
      digestTokens: Math.max(0, targetTokens - keepTokens),
    };
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
    const { budgetTokens, keepTokens, digestTokens: digestBudget } = this.budget();

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
    const lines = digestLines(cutEntries);

    // digestBudget is the target less the verbatim tail that survives it.
    // That bound is what makes a pass make progress.
    const summary = fitToBudget(lines, digestBudget, tokens);
    const message: ModelMessage = { role: "user", content: summary };
    const digestTokens = tokens.estimateMessage(message);

    // Backstop: never append a digest that does not shrink the live context.
    // Without this, a misconfigured budget turns every turn-end into a new row
    // that supersedes the previous digest with one the same size, forever.
    const cutTokens = cutEntries.reduce((sum, e) => sum + cost(e), 0);
    if (digestTokens >= cutTokens) {
      console.warn(
        `[compaction/two-tier] skipped: digest (${digestTokens} tokens) would not ` +
          `shrink the ${cutTokens} tokens it replaces. Raise targetTokens above ` +
          `keepTokens, or lower keepTokens.`,
      );
      return [];
    }

    const supersededThroughSeq = cutEntries[cutEntries.length - 1]!.seq;
    threads.append({
      threadId,
      kind: "compaction",
      supersedesThroughSeq: supersededThroughSeq,
      message,
      tokenEstimate: digestTokens,
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

/**
 * One line per fact, oldest first. Tier 1 happens here: a session fully
 * covered by the cut is represented by its summary alone, and its
 * dispatch/turn-end chatter is dropped rather than summarized.
 */
function digestLines(cutEntries: readonly ThreadEntry[]): string[] {
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
        // A prior compaction digest: keep its facts, drop its header so
        // headers do not nest as digests fold into each other.
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
  return lines;
}

/**
 * Assemble the digest so its token estimate lands under `budget`.
 *
 * Budgets are in tokens but truncation happens in characters, and the
 * estimator is a plugin — so rather than assume a ratio, this measures the
 * candidate it actually built and converts using that measurement, then
 * re-measures. Two passes are enough for a near-linear estimator; the loop
 * bound keeps a pathological one from spinning.
 *
 * Newest lines win. The oldest facts are the ones already carried through the
 * most digests, so they are both the least current and the most likely to
 * have been folded already.
 */
function fitToBudget(
  lines: readonly string[],
  budget: number,
  tokens: TokenEstimator,
): string {
  const assemble = (body: string[]): string => [COMPACTION_HEADER, ...body].join("\n");
  const measure = (text: string): number =>
    tokens.estimateMessage({ role: "user", content: text });

  let candidate = assemble([...lines]);
  let cost = measure(candidate);
  if (cost <= budget) return candidate;

  let targetChars = Math.max(0, Math.floor(budget * (candidate.length / cost)));

  for (let pass = 0; pass < 4 && cost > budget; pass++) {
    // No single fact may take more than a slice of the digest, or one long
    // session summary starves every other line out of the window.
    const maxLine = Math.max(200, Math.floor(targetChars / 6));
    const capped = lines.map((line) => truncate(line, maxLine));

    // Keep newest-first until the character target is spent.
    const kept: string[] = [];
    let used = 0;
    for (let i = capped.length - 1; i >= 0; i--) {
      const line = capped[i]!;
      if (used + line.length > targetChars && kept.length > 0) break;
      kept.unshift(line);
      used += line.length + 1;
    }
    const dropped = capped.length - kept.length;
    candidate = assemble(dropped > 0 ? [ELISION(dropped), ...kept] : kept);
    cost = measure(candidate);
    if (cost <= budget) break;
    // Overshot: scale the character target by how far off we were.
    targetChars = Math.max(0, Math.floor(targetChars * (budget / Math.max(1, cost))));
  }
  return candidate;
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
