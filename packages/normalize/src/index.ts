import { Service, type Context } from "@daydream-code/kernel";
import type { MessagePart, ModelMessage } from "@daydream-code/shared";

declare module "@daydream-code/kernel" {
  interface Context {
    normalizer: Normalizer;
  }
  interface Events {
    /**
     * @mode waterfall — transform a message on its way to durable storage.
     * Listeners receive (message, next) and may rewrite or pass through.
     */
    "normalize/persist"(
      message: ModelMessage,
      next: (message?: ModelMessage) => ModelMessage,
    ): ModelMessage;
    /** @mode waterfall — transform a stored message on its way into a model request. */
    "normalize/load"(
      message: ModelMessage,
      next: (message?: ModelMessage) => ModelMessage,
    ): ModelMessage;
  }
}

/**
 * Exclusive seam: the persistence-boundary normalizer. Applied on BOTH write
 * and read so a thread survives switching models/providers over its lifetime.
 * Plugins add rules by listening to the normalize/* waterfalls.
 */
export class Normalizer extends Service {
  constructor(ctx: Context) {
    super(ctx, "normalizer");
  }

  forPersist(message: ModelMessage): ModelMessage {
    return this.ctx.waterfall(
      "normalize/persist",
      [message],
      (m: ModelMessage) => m,
    ) as ModelMessage;
  }

  forLoad(message: ModelMessage): ModelMessage {
    return this.ctx.waterfall(
      "normalize/load",
      [message],
      (m: ModelMessage) => m,
    ) as ModelMessage;
  }
}

/**
 * Default rules (daydream's durableMessage, adapted):
 * - non-durable parts (images/files arriving as unknown shapes) -> markers
 * - empty text parts dropped (some providers reject them)
 * - a message whose content empties out gets a placeholder marker
 */
export const durableRules = {
  name: "normalize-durable",
  inject: ["normalizer"],
  apply(ctx: Context) {
    const clean = (message: ModelMessage): ModelMessage => {
      if (typeof message.content === "string") {
        return message.content.length > 0
          ? message
          : { ...message, content: "[an empty message passed here]" };
      }
      const parts: MessagePart[] = message.content
        .map((part): MessagePart | null => {
          if (part.type === "text") {
            return part.text.length > 0 ? part : null;
          }
          if (
            part.type === "tool_call" ||
            part.type === "tool_result" ||
            part.type === "marker"
          ) {
            return part;
          }
          return {
            type: "marker",
            text: "[non-durable content was attached here; it is not retained in memory]",
          };
        })
        .filter((part): part is MessagePart => part !== null);
      if (parts.length === 0) {
        return { ...message, content: "[a private thought passed here]" };
      }
      return { ...message, content: parts };
    };
    ctx.on(
      "normalize/persist",
      (message: ModelMessage, next: (m?: ModelMessage) => ModelMessage) =>
        next(clean(message)),
    );
    ctx.on(
      "normalize/load",
      (message: ModelMessage, next: (m?: ModelMessage) => ModelMessage) =>
        next(clean(message)),
    );
  },
};
