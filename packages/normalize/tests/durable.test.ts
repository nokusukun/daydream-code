import { describe, expect, it } from "vitest";
import { App } from "@daydream-code/kernel";
import { Normalizer, durableRules } from "@daydream-code/normalize";
import type { ImagePart, ModelMessage } from "@daydream-code/shared";

async function makeNormalizer(): Promise<Normalizer> {
  const app = new App();
  app.rootCtx.plugin(Normalizer, {});
  app.rootCtx.plugin(durableRules, {});
  await app.settle();
  return app.rootCtx.get<Normalizer>("normalizer")!;
}

const image: ImagePart = {
  type: "image",
  blobId: `${"b".repeat(64)}.png`,
  mediaType: "image/png",
  width: 8,
  height: 8,
  alt: "shot.png",
};

describe("durable normalize rules", () => {
  it("keeps images intact through persist and load", async () => {
    const normalizer = await makeNormalizer();
    const message: ModelMessage = {
      role: "user",
      content: [{ type: "text", text: "what is wrong here?" }, image],
    };
    // Both directions: the load path marker-izes too, so an image that
    // persisted but did not survive reload would still be lost.
    expect(normalizer.forPersist(message)).toEqual(message);
    expect(normalizer.forLoad(normalizer.forPersist(message))).toEqual(message);
  });

  it("still marker-izes genuinely non-durable parts", async () => {
    const normalizer = await makeNormalizer();
    const message = {
      role: "user",
      content: [{ type: "video", data: "…" }],
    } as unknown as ModelMessage;
    const cleaned = normalizer.forPersist(message);
    expect(cleaned.content).toEqual([
      {
        type: "marker",
        text: "[non-durable content was attached here; it is not retained in memory]",
      },
    ]);
  });

  it("does not drop a message that is only an image", async () => {
    const normalizer = await makeNormalizer();
    const cleaned = normalizer.forPersist({ role: "user", content: [image] });
    expect(cleaned.content).toEqual([image]);
  });
});
