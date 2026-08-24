import { beforeAll, describe, expect, it } from "vitest";
import { App } from "@daydream-code/kernel";
import { CharEstimator, type TokenEstimator } from "@daydream-code/tokens";
import type { ImagePart, ModelMessage } from "@daydream-code/shared";

let estimator: TokenEstimator;

beforeAll(async () => {
  const app = new App();
  app.rootCtx.plugin(CharEstimator, {});
  await app.settle();
  estimator = app.rootCtx.get<TokenEstimator>("tokens")!;
});

const image = (over: Partial<ImagePart> = {}): ImagePart => ({
  type: "image",
  blobId: `${"a".repeat(64)}.png`,
  mediaType: "image/png",
  width: 1092,
  height: 1092,
  ...over,
});

describe("CharEstimator", () => {
  it("still charges text at ~4 chars per token", () => {
    expect(estimator.estimateText("12345678")).toBe(2);
    const message: ModelMessage = { role: "user", content: "12345678" };
    expect(estimator.estimateMessage(message)).toBe(6); // 2 + 4 overhead
  });

  it("prices images by pixels, not by the size of their JSON", () => {
    const message: ModelMessage = { role: "user", content: [image()] };
    // 1092*1092/750 ≈ 1590, nothing like the ~30 tokens the blob ref stringifies to.
    expect(estimator.estimateMessage(message)).toBe(1594);
  });

  it("charges a full-size image when dimensions are unreadable", () => {
    const message: ModelMessage = {
      role: "user",
      content: [image({ width: undefined, height: undefined })],
    };
    expect(estimator.estimateMessage(message)).toBe(1604);
  });

  it("sums mixed content per part", () => {
    const message: ModelMessage = {
      role: "user",
      content: [{ type: "text", text: "12345678" }, image({ width: 30, height: 25 })],
    };
    // text part JSON + 1 image (30*25/750 = 1) + 4 overhead
    const textOnly = estimator.estimateMessage({
      role: "user",
      content: [{ type: "text", text: "12345678" }],
    });
    expect(estimator.estimateMessage(message)).toBe(textOnly + 1);
  });

  it("does not let a large image silently overrun the master budget", () => {
    // The regression this guards: estimating from a base64 payload would put a
    // 4MP screenshot near 300k tokens and force immediate compaction.
    const message: ModelMessage = {
      role: "user",
      content: [image({ width: 2000, height: 2000 })],
    };
    expect(estimator.estimateMessage(message)).toBeLessThan(10_000);
  });
});
