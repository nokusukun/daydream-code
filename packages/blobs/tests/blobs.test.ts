import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "@daydream-code/kernel";
import SqliteStore from "@daydream-code/store/sqlite";
import FsBlobs from "@daydream-code/blobs/fs";
import { Blobs } from "@daydream-code/blobs";
import { sniffImage, extensionFor } from "@daydream-code/blobs/sniff";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ddc-blobs-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

async function openBlobs(rootPath: string) {
  const app = new App();
  const errors: unknown[] = [];
  app.onError = (e) => errors.push(e);
  app.rootCtx.plugin(SqliteStore, { rootPath });
  app.rootCtx.plugin(FsBlobs, {});
  await app.settle();
  const blobs = app.rootCtx.get<Blobs>("blobs");
  if (!blobs) throw new Error(`blobs failed: ${errors.map(String).join("; ")}`);
  cleanups.push(() => app.dispose(app.rootFiber));
  return { blobs, dataDir: path.join(rootPath, ".daydream-code") };
}

/** Smallest valid PNG: 1x1, then a real IHDR with the dimensions we assert. */
function png(width: number, height: number): Uint8Array {
  const header = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.write("\x00\x00\x00\x0dIHDR", 8, "latin1");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return new Uint8Array(Buffer.concat([header, Buffer.from("trailing-pixels")]));
}

function jpeg(width: number, height: number): Uint8Array {
  // SOI, a APP0 segment to skip over, then SOF0 carrying the dimensions.
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(0x0011, 2);
  sof.writeUInt8(8, 4);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return new Uint8Array(
    Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]),
  );
}

function gif(width: number, height: number): Uint8Array {
  const buf = Buffer.alloc(10);
  buf.write("GIF89a", 0, "latin1");
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return new Uint8Array(buf);
}

describe("sniffImage", () => {
  it("reads png dimensions from IHDR", () => {
    expect(sniffImage(png(1092, 800))).toEqual({
      mediaType: "image/png",
      width: 1092,
      height: 800,
    });
  });

  it("walks jpeg segments to the frame header", () => {
    expect(sniffImage(jpeg(640, 480))).toEqual({
      mediaType: "image/jpeg",
      width: 640,
      height: 480,
    });
  });

  it("reads gif dimensions little-endian", () => {
    expect(sniffImage(gif(32, 16))).toEqual({
      mediaType: "image/gif",
      width: 32,
      height: 16,
    });
  });

  it("rejects non-images rather than trusting a filename", () => {
    expect(sniffImage(new Uint8Array(Buffer.from("#!/bin/sh\nrm -rf /")))).toBeNull();
    expect(sniffImage(new Uint8Array(0))).toBeNull();
  });

  it("maps media types to the extensions blob ids carry", () => {
    expect(extensionFor("image/png")).toBe("png");
    expect(extensionFor("image/jpeg")).toBe("jpg");
    expect(extensionFor("application/pdf")).toBe("bin");
  });
});

describe("FsBlobs", () => {
  it("stores content-addressed, deduplicating identical bytes", async () => {
    const { blobs, dataDir } = await openBlobs(tempRoot());
    const first = blobs.put(png(10, 10));
    const second = blobs.put(png(10, 10));

    expect(second.id).toBe(first.id);
    expect(first.id).toMatch(/^[a-f0-9]{64}\.png$/);
    expect(first).toMatchObject({ mediaType: "image/png", width: 10, height: 10 });
    expect(fs.readdirSync(path.join(dataDir, "blobs"))).toEqual([first.id]);
  });

  it("round-trips bytes through path/read/has", async () => {
    const { blobs } = await openBlobs(tempRoot());
    const ref = blobs.put(png(4, 4));
    expect(blobs.has(ref.id)).toBe(true);
    expect(new Uint8Array(blobs.read(ref.id))).toEqual(png(4, 4));
    expect(fs.existsSync(blobs.path(ref.id))).toBe(true);
    expect(blobs.has("0".repeat(64) + ".png")).toBe(false);
  });

  it("ingests a file from disk and keeps its name as alt text", async () => {
    const root = tempRoot();
    const { blobs } = await openBlobs(root);
    const file = path.join(root, "shot.png");
    fs.writeFileSync(file, png(20, 30));
    expect(blobs.putFile(file)).toMatchObject({
      mediaType: "image/png",
      width: 20,
      height: 30,
    });
  });

  it("refuses unsupported content, missing files, and oversized images", async () => {
    const root = tempRoot();
    const { blobs } = await openBlobs(root);
    const bad = path.join(root, "notes.txt");
    fs.writeFileSync(bad, "just text");
    expect(() => blobs.putFile(bad)).toThrow(/unsupported attachment/);
    expect(() => blobs.putFile(path.join(root, "ghost.png"))).toThrow(/no such image/);
  });

  it("refuses blob ids that could escape the blob directory", async () => {
    const { blobs } = await openBlobs(tempRoot());
    expect(() => blobs.path("../../etc/passwd")).toThrow(/malformed blob id/);
    expect(blobs.has("../../etc/passwd")).toBe(false);
  });

  it("keeps blobs out of git, without clobbering the store's gitignore", async () => {
    const { dataDir } = await openBlobs(tempRoot());
    const ignored = fs.readFileSync(path.join(dataDir, ".gitignore"), "utf8");
    expect(ignored).toContain("*.sqlite*");
    expect(ignored).toContain("blobs/");
  });
});
