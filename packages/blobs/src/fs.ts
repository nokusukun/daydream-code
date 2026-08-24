import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { defineConfig, field } from "@daydream-code/config";
import type { Context } from "@daydream-code/kernel";
import type {} from "@daydream-code/store";
import { Blobs, type BlobRef } from "./index.js";
import { extensionFor, sniffImage } from "./sniff.js";

/** Enough of a header for every format's dimension fields. */
const HEADER_BYTES = 64 * 1024;

const { Config, settings } = defineConfig({
  maxBytes: field.number({
    label: "attachment limit",
    help: "images larger than this are rejected; a stray video would blow up the prompt.",
    default: 16 * 1024 * 1024,
    integer: true,
    min: 1,
    unit: "bytes",
  }),
});

/**
 * Default provider: content-addressed files under `<dataDir>/blobs`.
 *
 * Inside the project directory on purpose — the Codex sandbox modes
 * (`read-only`, `workspace-write`) will not open a `local_image` path outside
 * the workspace, so a temp-dir blob store would silently fail there.
 */
export default class FsBlobs extends Blobs {
  static inject = ["store"];
  static Config = Config;
  static settings = settings;

  readonly #dir: string;
  readonly #maxBytes: number;

  constructor(ctx: Context, config: z.infer<typeof Config>) {
    super(ctx);
    this.#maxBytes = config.maxBytes;
    this.#dir = path.join(ctx.store.dataDir, "blobs");
    fs.mkdirSync(this.#dir, { recursive: true });
    // The store writes `.daydream-code/.gitignore` only when absent, so an
    // existing project would start committing blobs. Append instead.
    const gitignore = path.join(ctx.store.dataDir, ".gitignore");
    const current = fs.existsSync(gitignore)
      ? fs.readFileSync(gitignore, "utf8")
      : "";
    if (!current.split(/\r?\n/).includes("blobs/")) {
      fs.writeFileSync(gitignore, `${current}${current.endsWith("\n") || current.length === 0 ? "" : "\n"}blobs/\n`);
    }
  }

  put(data: Uint8Array, alt?: string): BlobRef {
    if (data.length > this.#maxBytes) {
      throw new Error(
        `image is ${data.length} bytes, over the ${this.#maxBytes} byte limit`,
      );
    }
    const sniffed = sniffImage(data);
    if (sniffed === null) {
      throw new Error(
        `unsupported attachment${alt ? ` "${alt}"` : ""}: expected png, jpeg, gif or webp`,
      );
    }
    const digest = createHash("sha256").update(data).digest("hex");
    const id = `${digest}.${extensionFor(sniffed.mediaType)}`;
    const file = path.join(this.#dir, id);
    // Content-addressed: identical bytes are already the same file.
    if (!fs.existsSync(file)) fs.writeFileSync(file, data);
    return {
      id,
      mediaType: sniffed.mediaType,
      bytes: data.length,
      ...(sniffed.width !== undefined ? { width: sniffed.width } : {}),
      ...(sniffed.height !== undefined ? { height: sniffed.height } : {}),
    };
  }

  putFile(filePath: string): BlobRef {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`no such image: ${resolved}`);
    }
    return this.put(fs.readFileSync(resolved), path.basename(resolved));
  }

  stat(id: string): BlobRef | undefined {
    let file: string;
    try {
      file = this.path(id);
    } catch {
      // A malformed id is a miss, not a crash: it arrives from a client.
      return undefined;
    }
    let stats: fs.Stats;
    let header: Buffer;
    try {
      stats = fs.statSync(file);
      // Only the header is needed, and a 16 MB read per attached image would
      // be paid on every dispatch. 64 KB clears any real JPEG marker chain;
      // past that the sniffer degrades to a media type with no dimensions,
      // which the estimator already has a fallback for.
      const handle = fs.openSync(file, "r");
      try {
        header = Buffer.alloc(Math.min(stats.size, HEADER_BYTES));
        fs.readSync(handle, header, 0, header.length, 0);
      } finally {
        fs.closeSync(handle);
      }
    } catch {
      return undefined;
    }
    const sniffed = sniffImage(header);
    if (sniffed === null) return undefined;
    return {
      id,
      mediaType: sniffed.mediaType,
      bytes: stats.size,
      ...(sniffed.width !== undefined ? { width: sniffed.width } : {}),
      ...(sniffed.height !== undefined ? { height: sniffed.height } : {}),
    };
  }

  path(id: string): string {
    // Ids are hex + extension by construction; refuse anything that could
    // escape the blob directory if one ever arrives from a client.
    if (!/^[a-f0-9]{64}\.[a-z0-9]{1,8}$/.test(id)) {
      throw new Error(`malformed blob id: ${id}`);
    }
    return path.join(this.#dir, id);
  }

  read(id: string): Buffer {
    return fs.readFileSync(this.path(id));
  }

  has(id: string): boolean {
    try {
      return fs.existsSync(this.path(id));
    } catch {
      return false;
    }
  }
}
