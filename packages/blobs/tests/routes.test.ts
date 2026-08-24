import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { App, type Context } from "@daydream-code/kernel";
import { HttpError, HttpRoutes, type RouteRequest } from "@daydream-code/routes";
import SqliteStore from "@daydream-code/store/sqlite";
import FsBlobs from "@daydream-code/blobs/fs";
import blobRoutes from "@daydream-code/blobs/routes";
import type { Blobs } from "@daydream-code/blobs";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

/** A 1×1-shaped PNG header with real dimensions, as the sniffer reads them. */
function png(width: number, height: number, tail = "pixels"): Uint8Array {
  const header = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.write("\x00\x00\x00\x0dIHDR", 8, "latin1");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return new Uint8Array(Buffer.concat([header, Buffer.from(tail)]));
}

async function mount() {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ddc-blob-routes-"));
  cleanups.push(() =>
    fs.rmSync(rootPath, { recursive: true, force: true, maxRetries: 5 }),
  );
  const app = new App();
  const errors: unknown[] = [];
  app.onError = (error) => errors.push(error);
  const ctx = app.rootCtx as Context;
  ctx.plugin(HttpRoutes);
  ctx.plugin(SqliteStore, { rootPath });
  ctx.plugin(FsBlobs, {});
  ctx.plugin(blobRoutes);
  await app.settle();
  cleanups.push(() => app.dispose(app.rootFiber));
  const routes = ctx.get<HttpRoutes>("routes")!;
  if (routes === undefined) throw new Error(errors.map(String).join("; "));

  /** Dispatch the way a transport does: match, then hand the handler a request. */
  const call = async (
    method: "GET" | "POST",
    urlPath: string,
    body?: unknown,
  ): Promise<unknown> => {
    const match = routes.match(method, urlPath);
    if (match === undefined) throw new Error(`no route for ${method} ${urlPath}`);
    return match.route.handle({
      method,
      path: urlPath,
      params: match.params,
      query: {},
      headers: {},
      body,
    } as RouteRequest);
  };

  return { app, ctx, call, blobs: ctx.get<Blobs>("blobs")!, errors };
}

describe("blob routes", () => {
  it("stores an upload and reads the same bytes back", async () => {
    const { call } = await mount();
    const bytes = png(1092, 800);
    const ref = (await call("POST", "/api/blobs", {
      data: Buffer.from(bytes).toString("base64"),
      alt: "shot.png",
    })) as { id: string; mediaType: string; width: number; height: number };

    // Sniffed from the bytes, not taken from the filename or the caller.
    expect(ref.mediaType).toBe("image/png");
    expect([ref.width, ref.height]).toEqual([1092, 800]);
    expect(ref.id).toMatch(/^[a-f0-9]{64}\.png$/);

    const content = (await call("GET", `/api/blobs/${ref.id}`)) as {
      data: string;
      mediaType: string;
      width: number;
    };
    expect(Buffer.from(content.data, "base64").equals(Buffer.from(bytes))).toBe(
      true,
    );
    expect(content.mediaType).toBe("image/png");
    expect(content.width).toBe(1092);
  });

  it("gives the same id to the same image twice", async () => {
    const { call, blobs } = await mount();
    const data = Buffer.from(png(4, 4)).toString("base64");
    const first = (await call("POST", "/api/blobs", { data })) as { id: string };
    const second = (await call("POST", "/api/blobs", { data, alt: "again.png" })) as {
      id: string;
    };
    // Content-addressed: pasting a screenshot into two composers is one file.
    expect(second.id).toBe(first.id);
    expect(blobs.has(first.id)).toBe(true);
  });

  it("refuses something that is not an image, with a status a client can act on", async () => {
    const { call } = await mount();
    await expect(
      call("POST", "/api/blobs", {
        data: Buffer.from("this is a text file, not a png").toString("base64"),
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(call("POST", "/api/blobs", { data: "" })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("is a 404 for bytes that are not there, so a stale draft can retire its chip", async () => {
    const { call } = await mount();
    const missing = `${"a".repeat(64)}.png`;
    await expect(call("GET", `/api/blobs/${missing}`)).rejects.toBeInstanceOf(
      HttpError,
    );
    await expect(call("GET", `/api/blobs/${missing}`)).rejects.toMatchObject({
      status: 404,
    });
    // A malformed id is a miss too, not a path escaping the blob directory.
    await expect(
      call("GET", "/api/blobs/..%2F..%2Fetc%2Fpasswd"),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("unregisters with the plugin that owns it", async () => {
    const { app, ctx, call } = await mount();
    const fiber = [...app.rootFiber.children].find(
      (f) => f.name === "blob-routes",
    );
    expect(fiber).toBeDefined();
    await app.dispose(fiber!);
    expect(ctx.get<HttpRoutes>("routes")!.match("POST", "/api/blobs")).toBeUndefined();
    await expect(call("POST", "/api/blobs", { data: "" })).rejects.toThrow(
      /no route/,
    );
  });
});

describe("Blobs.stat", () => {
  it("reads dimensions back off disk without loading the whole file", async () => {
    const { blobs } = await mount();
    // Far past the header window, so a full read is measurably not happening.
    const big = png(320, 240, "x".repeat(200_000));
    const ref = blobs.put(big);
    const stat = blobs.stat(ref.id);
    expect(stat).toEqual({
      id: ref.id,
      mediaType: "image/png",
      bytes: big.length,
      width: 320,
      height: 240,
    });
  });

  it("is undefined for anything it does not hold", async () => {
    const { blobs } = await mount();
    expect(blobs.stat(`${"b".repeat(64)}.png`)).toBeUndefined();
    expect(blobs.stat("../../etc/passwd")).toBeUndefined();
  });
});
