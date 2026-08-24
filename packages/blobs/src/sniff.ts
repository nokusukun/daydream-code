/**
 * Header sniffing for the image formats the providers accept.
 *
 * Media type comes from magic bytes rather than the filename: a screenshot
 * pasted from the clipboard has no filename, and a wrong `image/png` on JPEG
 * bytes is rejected by the provider at request time.
 *
 * Dimensions matter because token cost scales with pixels, not file size —
 * see the estimator. When a header is unreadable, dimensions are omitted and
 * the estimator falls back to a fixed cost.
 */
export interface Sniffed {
  mediaType: string;
  width?: number;
  height?: number;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(data: Uint8Array, bytes: readonly number[]): boolean {
  if (data.length < bytes.length) return false;
  return bytes.every((b, i) => data[i] === b);
}

function ascii(data: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...data.subarray(start, start + length));
}

const be16 = (d: Uint8Array, i: number): number => (d[i]! << 8) | d[i + 1]!;
const le16 = (d: Uint8Array, i: number): number => d[i]! | (d[i + 1]! << 8);
const be32 = (d: Uint8Array, i: number): number =>
  ((d[i]! << 24) | (d[i + 1]! << 16) | (d[i + 2]! << 8) | d[i + 3]!) >>> 0;

function png(data: Uint8Array): Sniffed {
  // IHDR is always the first chunk: 8 magic + 4 length + 4 type, then w/h.
  if (data.length < 24) return { mediaType: "image/png" };
  return {
    mediaType: "image/png",
    width: be32(data, 16),
    height: be32(data, 20),
  };
}

function jpeg(data: Uint8Array): Sniffed {
  // Walk the segment chain to the frame header; only SOF carries dimensions.
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = data[offset + 1]!;
    // SOF0..SOF15, excluding DHT (c4), JPGA (c8) and DAC (cc).
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      return {
        mediaType: "image/jpeg",
        height: be16(data, offset + 5),
        width: be16(data, offset + 7),
      };
    }
    const length = be16(data, offset + 2);
    if (length < 2) break;
    offset += 2 + length;
  }
  return { mediaType: "image/jpeg" };
}

function gif(data: Uint8Array): Sniffed {
  if (data.length < 10) return { mediaType: "image/gif" };
  return { mediaType: "image/gif", width: le16(data, 6), height: le16(data, 8) };
}

function webp(data: Uint8Array): Sniffed {
  const out: Sniffed = { mediaType: "image/webp" };
  if (data.length < 30) return out;
  const chunk = ascii(data, 12, 4);
  if (chunk === "VP8X") {
    // 24-bit little-endian, stored as (dimension - 1).
    const w = (data[24]! | (data[25]! << 8) | (data[26]! << 16)) + 1;
    const h = (data[27]! | (data[28]! << 8) | (data[29]! << 16)) + 1;
    return { ...out, width: w, height: h };
  }
  if (chunk === "VP8 " && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) {
    return {
      ...out,
      width: le16(data, 26) & 0x3fff,
      height: le16(data, 28) & 0x3fff,
    };
  }
  if (chunk === "VP8L" && data[20] === 0x2f) {
    const bits = data[21]! | (data[22]! << 8) | (data[23]! << 16) | (data[24]! << 24);
    return {
      ...out,
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  return out;
}

/** Identify supported image bytes, or null if this is not an image we accept. */
export function sniffImage(data: Uint8Array): Sniffed | null {
  if (startsWith(data, PNG_MAGIC)) return png(data);
  if (startsWith(data, [0xff, 0xd8, 0xff])) return jpeg(data);
  if (data.length >= 6 && (ascii(data, 0, 6) === "GIF87a" || ascii(data, 0, 6) === "GIF89a")) {
    return gif(data);
  }
  if (data.length >= 12 && ascii(data, 0, 4) === "RIFF" && ascii(data, 8, 4) === "WEBP") {
    return webp(data);
  }
  return null;
}

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** File extension for a sniffed media type. Blob ids carry it so that the
 *  Codex SDK, which only receives a path, can still identify the format. */
export function extensionFor(mediaType: string): string {
  return EXTENSIONS[mediaType] ?? "bin";
}
