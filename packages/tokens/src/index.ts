import { Service, type Context } from "@daydream-code/kernel";
import type { ModelMessage, ThreadEntry } from "@daydream-code/shared";

declare module "@daydream-code/kernel" {
  interface Context {
    tokens: TokenEstimator;
  }
}

/** Exclusive seam: token estimation. Default provider is chars/4. */
export abstract class TokenEstimator extends Service {
  constructor(ctx: Context) {
    super(ctx, "tokens");
  }

  abstract estimateText(text: string): number;
  abstract estimateMessage(message: ModelMessage): number;

  estimateEntries(entries: readonly ThreadEntry[]): number {
    return entries.reduce((sum, e) => sum + (e.tokenEstimate || this.estimateMessage(e.message)), 0);
  }
}

/** Default provider: ~4 chars per token, +4 per message overhead. */
export class CharEstimator extends TokenEstimator {
  estimateText(text: string): number {
    return Math.ceil(text.length / 4);
  }

  estimateMessage(message: ModelMessage): number {
    const content =
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content);
    return this.estimateText(content) + 4;
  }
}
