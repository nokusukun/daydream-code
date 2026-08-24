import { Service, type Context } from "@daydream-code/kernel";
import type { ImagePart, ModelMessage, ThreadEntry } from "@daydream-code/shared";

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

/**
 * Cost of an image, which scales with pixels rather than bytes. Roughly
 * `(width x height) / 750`, the published rule of thumb.
 *
 * Falling back to JSON.stringify here would be catastrophic rather than
 * merely imprecise: an ImagePart is a short blob reference, so a 4 MB
 * screenshot would estimate at a few dozen tokens and quietly overrun the
 * master budget. An unmeasurable image is charged a typical full-size cost.
 */
const IMAGE_TOKENS_UNKNOWN = 1600;

function estimateImage(part: ImagePart): number {
  if (part.width === undefined || part.height === undefined) {
    return IMAGE_TOKENS_UNKNOWN;
  }
  return Math.ceil((part.width * part.height) / 750);
}

/** Default provider: ~4 chars per token, +4 per message overhead. */
export class CharEstimator extends TokenEstimator {
  estimateText(text: string): number {
    return Math.ceil(text.length / 4);
  }

  estimateMessage(message: ModelMessage): number {
    if (typeof message.content === "string") {
      return this.estimateText(message.content) + 4;
    }
    // Sum per part: images are priced by pixels, everything else by its JSON.
    const total = message.content.reduce((sum, part) => {
      if (part.type === "image") return sum + estimateImage(part);
      return sum + this.estimateText(JSON.stringify(part));
    }, 0);
    return total + 4;
  }
}
