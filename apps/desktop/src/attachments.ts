/**
 * Images on their way into a composer: picked, pasted or dropped, uploaded to
 * the blob store, and held as references until the message is sent.
 *
 * The upload happens when the image arrives, not when the message is sent.
 * That is what makes an attachment survivable: the composer holds a blob id of
 * a hundred bytes instead of megabytes of base64, so a draft can persist it in
 * `localStorage` without spending a quota that is measured in single-digit
 * megabytes, a failed send costs no re-upload, and the same screenshot pasted
 * twice is the same file on disk (blob ids are content hashes).
 *
 * DOM-free on purpose — everything here takes the smallest structural type it
 * can, so the whole path tests headless with plain objects and a fake fetch.
 */
import type { ApiClient } from "./api.js";

/** An image the composer is holding, and what a draft persists for it. */
export interface Attachment {
  /** Content-addressed blob id; the only field the server is handed back. */
  blobId: string;
  mediaType: string;
  bytes: number;
  width?: number;
  height?: number;
  /** Original filename when there was one. A clipboard paste has none. */
  name?: string;
}

/** The slice of `File` this needs, so tests do not need a DOM. */
export interface ImageFile {
  name?: string;
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** The slice of `DataTransfer` this needs (clipboard and drop share it). */
export interface TransferLike {
  files?: ArrayLike<ImageFile> | null;
  items?: ArrayLike<{ kind?: string; type?: string; getAsFile?(): ImageFile | null }> | null;
}

/**
 * How many images one message may carry.
 *
 * Not a storage limit — the store takes each one happily — but a context one:
 * every attached image is charged by its pixel count against the same budget
 * the conversation is spending, so a dropped folder of screenshots would
 * quietly evict the conversation it was meant to illustrate. Refusing loudly
 * at eight beats compacting silently at thirty.
 */
export const MAX_ATTACHMENTS = 8;

/** Chunked so a multi-megabyte screenshot cannot overflow the argument stack. */
export function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  // btoa is in every browser and in Node since 16; the renderer has it either
  // way, and so does the test runner.
  return btoa(binary);
}

/** Render a stored blob as something `<img src>` accepts. */
export function dataUrl(mediaType: string, base64: string): string {
  return `data:${mediaType};base64,${base64}`;
}

/**
 * The images in a paste or a drop, and nothing else.
 *
 * Clipboard payloads are multi-part: copying an image out of a browser hands
 * over an `image/png` *and* the HTML that contained it, and copying text hands
 * over no files at all. Filtering here rather than at the call site is what
 * lets the handler decide whether to preventDefault — a paste with no images
 * has to fall through to the textarea untouched.
 */
export function imageFiles(transfer: TransferLike | null | undefined): ImageFile[] {
  if (!transfer) return [];
  const found: ImageFile[] = [];
  const files = transfer.files;
  if (files) {
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      if (file && file.type.startsWith("image/")) found.push(file);
    }
  }
  // A clipboard image usually arrives as an item rather than a file. Fall back
  // to items only when files came up empty, so a drop is not counted twice.
  const items = transfer.items;
  if (found.length === 0 && items) {
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (!item || item.kind !== "file") continue;
      if (!item.type?.startsWith("image/")) continue;
      const file = item.getAsFile?.();
      if (file) found.push(file);
    }
  }
  return found;
}

/**
 * Whether a drag carries files at all.
 *
 * A `dragover` cannot see what is being dragged — `files` is empty and items
 * refuse `getAsFile` until the drop — so this is the most a composer can know
 * while deciding whether to light up and accept the drop. Dragged text is
 * excluded, which is the case that matters: it would otherwise be swallowed by
 * a drop handler that then found nothing to attach.
 */
export function transferHasFiles(
  transfer: { types?: ArrayLike<string> | null } | null | undefined,
): boolean {
  const types = transfer?.types;
  if (!types) return false;
  for (let i = 0; i < types.length; i += 1) {
    if (types[i] === "Files") return true;
  }
  return false;
}

/** Store one image and return the reference a message will carry. */
export async function uploadImage(
  api: Pick<ApiClient, "uploadBlob">,
  file: ImageFile,
): Promise<Attachment> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const name = file.name !== undefined && file.name.length > 0 ? file.name : undefined;
  const ref = await api.uploadBlob(toBase64(bytes), name);
  return {
    blobId: ref.id,
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    ...(ref.width !== undefined ? { width: ref.width } : {}),
    ...(ref.height !== undefined ? { height: ref.height } : {}),
    ...(name !== undefined ? { name } : {}),
  };
}

/** The wire form: only the id is trusted, the rest is re-sniffed server-side. */
export function attachmentInput(attachment: Attachment): {
  blobId: string;
  alt?: string;
} {
  return {
    blobId: attachment.blobId,
    ...(attachment.name !== undefined ? { alt: attachment.name } : {}),
  };
}

/** "screenshot.png" or "png · 1092×800" — a chip has room for one line. */
export function attachmentLabel(attachment: Attachment): string {
  if (attachment.name !== undefined) return attachment.name;
  const kind = attachment.mediaType.replace(/^image\//, "");
  return attachment.width !== undefined && attachment.height !== undefined
    ? `${kind} · ${attachment.width}×${attachment.height}`
    : kind;
}

/** "1 image" / "3 images" — for rail previews, where there is no room to draw them. */
export function attachmentSummary(count: number): string {
  return count === 1 ? "1 image" : `${count} images`;
}

/**
 * Blob bytes, once per id per window.
 *
 * Ids are content hashes, so a cached entry can never be stale — the only
 * bound needed is on memory. Entries are dropped oldest-first past the cap,
 * which is a `Map`'s insertion order for free.
 */
const CACHE_LIMIT = 48;
const cache = new Map<string, Promise<string>>();

export function blobDataUrl(
  api: Pick<ApiClient, "blob">,
  blobId: string,
): Promise<string> {
  const hit = cache.get(blobId);
  if (hit !== undefined) return hit;
  const pending = api
    .blob(blobId)
    .then((content) => dataUrl(content.mediaType, content.data));
  // A failed fetch must not be remembered as a failure forever: a 404 today can
  // be a real blob tomorrow, and a dropped connection is not an answer.
  pending.catch(() => cache.delete(blobId));
  cache.set(blobId, pending);
  for (const key of cache.keys()) {
    if (cache.size <= CACHE_LIMIT) break;
    cache.delete(key);
  }
  return pending;
}

/** Test seam; the renderer never needs this. */
export function clearBlobCache(): void {
  cache.clear();
}
