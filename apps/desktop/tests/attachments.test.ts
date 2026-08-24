import { describe, expect, it } from "vitest";
import { ApiClient, ApiError } from "../src/api.js";
import {
  attachmentInput,
  attachmentLabel,
  attachmentSummary,
  blobDataUrl,
  clearBlobCache,
  imageFiles,
  toBase64,
  transferHasFiles,
  uploadImage,
  type Attachment,
  type ImageFile,
} from "../src/attachments.js";

/** A pasted file, with only the surface the code actually touches. */
function file(type: string, bytes: number[], name?: string): ImageFile {
  return {
    type,
    ...(name !== undefined ? { name } : {}),
    arrayBuffer: async () => new Uint8Array(bytes).buffer,
  };
}

describe("toBase64", () => {
  it("matches Buffer for a payload past one chunk", () => {
    // 0x8000 is the chunk boundary; a screenshot is many times this, and the
    // naive spread-into-fromCharCode overflows the argument stack there.
    const bytes = new Uint8Array(0x8000 * 2 + 17);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 7) % 256;
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });

  it("round-trips through the decoder the server uses", () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255, 128]);
    expect([...Buffer.from(toBase64(bytes), "base64")]).toEqual([...bytes]);
  });
});

describe("imageFiles", () => {
  it("takes the images out of a drop", () => {
    const files = imageFiles({
      files: [file("image/png", [1], "a.png"), file("text/plain", [2], "b.txt")],
    });
    expect(files.map((f) => f.name)).toEqual(["a.png"]);
  });

  it("finds a clipboard image, which arrives as an item and not a file", () => {
    const pasted = file("image/png", [1]);
    const files = imageFiles({
      files: [],
      items: [
        { kind: "string", type: "text/html", getAsFile: () => null },
        { kind: "file", type: "image/png", getAsFile: () => pasted },
      ],
    });
    expect(files).toEqual([pasted]);
  });

  it("does not count a dropped file twice", () => {
    const dropped = file("image/png", [1], "a.png");
    expect(
      imageFiles({
        files: [dropped],
        items: [{ kind: "file", type: "image/png", getAsFile: () => dropped }],
      }),
    ).toHaveLength(1);
  });

  it("is empty for a plain text paste, so the textarea keeps it", () => {
    expect(
      imageFiles({
        files: [],
        items: [{ kind: "string", type: "text/plain", getAsFile: () => null }],
      }),
    ).toEqual([]);
    expect(imageFiles(null)).toEqual([]);
  });
});

describe("transferHasFiles", () => {
  it("is what a dragover can know, and nothing more", () => {
    expect(transferHasFiles({ types: ["Files"] })).toBe(true);
    expect(transferHasFiles({ types: ["text/plain"] })).toBe(false);
    expect(transferHasFiles(undefined)).toBe(false);
  });
});

describe("uploadImage", () => {
  it("posts the bytes once and keeps only the reference", async () => {
    const posted: Array<{ url: string; body: unknown }> = [];
    const api = new ApiClient({
      baseUrl: "http://core",
      fetchImpl: async (input, init) => {
        posted.push({
          url: String(input),
          body: JSON.parse(String(init?.body ?? "null")),
        });
        return new Response(
          JSON.stringify({
            id: "abc.png",
            mediaType: "image/png",
            bytes: 3,
            width: 8,
            height: 4,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const attachment = await uploadImage(api, file("image/png", [1, 2, 3], "s.png"));

    expect(posted).toEqual([
      {
        url: "http://core/api/blobs",
        body: { data: Buffer.from([1, 2, 3]).toString("base64"), alt: "s.png" },
      },
    ]);
    // What the composer holds, and what a draft persists: no bytes.
    expect(attachment).toEqual({
      blobId: "abc.png",
      mediaType: "image/png",
      bytes: 3,
      width: 8,
      height: 4,
      name: "s.png",
    });
    expect(JSON.stringify(attachment).length).toBeLessThan(200);
  });

  it("sends a clipboard image with no name at all", async () => {
    let body: unknown;
    const api = new ApiClient({
      baseUrl: "http://core",
      fetchImpl: async (_input, init) => {
        body = JSON.parse(String(init?.body ?? "null"));
        return new Response(
          JSON.stringify({ id: "z.png", mediaType: "image/png", bytes: 1 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    const attachment = await uploadImage(api, file("image/png", [9]));
    expect(body).toEqual({ data: Buffer.from([9]).toString("base64") });
    expect(attachment.name).toBeUndefined();
    expect(attachmentLabel(attachment)).toBe("png");
  });
});

describe("attachmentInput", () => {
  it("hands back the id and the filename, and nothing it could lie about", () => {
    const attachment: Attachment = {
      blobId: "abc.png",
      mediaType: "image/png",
      bytes: 9,
      width: 4000,
      height: 4000,
      name: "s.png",
    };
    // Dimensions price the turn, so they are re-sniffed server-side rather
    // than accepted from a client that could claim a screenshot is 1×1.
    expect(attachmentInput(attachment)).toEqual({
      blobId: "abc.png",
      alt: "s.png",
    });
  });
});

describe("attachmentLabel / attachmentSummary", () => {
  it("prefers a filename and falls back to the shape of the image", () => {
    expect(
      attachmentLabel({ blobId: "a", mediaType: "image/png", bytes: 1, name: "shot.png" }),
    ).toBe("shot.png");
    expect(
      attachmentLabel({
        blobId: "a",
        mediaType: "image/png",
        bytes: 1,
        width: 1092,
        height: 800,
      }),
    ).toBe("png · 1092×800");
  });

  it("counts", () => {
    expect(attachmentSummary(1)).toBe("1 image");
    expect(attachmentSummary(3)).toBe("3 images");
  });
});

describe("blobDataUrl", () => {
  it("fetches a blob once however many places draw it", async () => {
    clearBlobCache();
    let calls = 0;
    const api = {
      blob: async (id: string) => {
        calls += 1;
        return { id, mediaType: "image/png", bytes: 1, data: "AAEC" };
      },
    };
    const first = await blobDataUrl(api, "abc.png");
    const second = await blobDataUrl(api, "abc.png");
    expect(first).toBe("data:image/png;base64,AAEC");
    expect(second).toBe(first);
    // Ids are content hashes, so a second read could only ever agree.
    expect(calls).toBe(1);
  });

  it("does not remember a failure", async () => {
    clearBlobCache();
    let calls = 0;
    const api = {
      blob: async (id: string) => {
        calls += 1;
        if (calls === 1) throw new ApiError(404, "gone");
        return { id, mediaType: "image/png", bytes: 1, data: "AAEC" };
      },
    };
    await expect(blobDataUrl(api, "abc.png")).rejects.toThrow(/gone/);
    // A 404 today can be a real blob tomorrow — the same chip must be able to
    // resolve after a retry rather than being poisoned for the session.
    await expect(blobDataUrl(api, "abc.png")).resolves.toBe(
      "data:image/png;base64,AAEC",
    );
    expect(calls).toBe(2);
  });
});
