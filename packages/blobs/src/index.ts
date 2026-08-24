import { Service, type Context } from "@daydream-code/kernel";
import type { ImagePart } from "@daydream-code/shared";

declare module "@daydream-code/kernel" {
  interface Context {
    blobs: Blobs;
  }
}

export interface BlobRef {
  /** Content-addressed id, `<sha256>.<ext>`. Stable across projects. */
  id: string;
  mediaType: string;
  bytes: number;
  width?: number;
  height?: number;
}

/**
 * Exclusive seam: binary attachments, kept out of the database on purpose.
 *
 * Content-addressed so the same screenshot pasted twice costs one copy, and
 * path-resolvable because the Codex SDK accepts images only as
 * `{ type: "local_image", path }` — it has no base64 or URL form. Claude reads
 * the same file and encodes it once per turn.
 */
export abstract class Blobs extends Service {
  constructor(ctx: Context) {
    super(ctx, "blobs");
  }

  /** Store bytes, sniffing the media type and dimensions from the header. */
  abstract put(data: Uint8Array, alt?: string): BlobRef;
  /** Store a file from disk by path. Throws if it is not a supported image. */
  abstract putFile(filePath: string): BlobRef;
  /**
   * What is on disk for a blob id, or undefined when nothing is. Re-sniffed
   * from the bytes rather than remembered, because the store has no index: the
   * filesystem is the record, and a client handing back an id it was given
   * earlier must not be able to assert its own dimensions (they price the
   * turn).
   */
  abstract stat(id: string): BlobRef | undefined;
  /** Absolute on-disk path for a blob id. Does not check existence. */
  abstract path(id: string): string;
  abstract read(id: string): Buffer;
  abstract has(id: string): boolean;
}

/** Build the durable message part for a stored blob. */
export function imagePart(ref: BlobRef, alt?: string): ImagePart {
  return {
    type: "image",
    blobId: ref.id,
    mediaType: ref.mediaType,
    ...(ref.width !== undefined ? { width: ref.width } : {}),
    ...(ref.height !== undefined ? { height: ref.height } : {}),
    ...(alt !== undefined ? { alt } : {}),
  };
}
