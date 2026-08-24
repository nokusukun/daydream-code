/**
 * Images that came in with a message, drawn in the transcript.
 *
 * The journal stores them as references (`{type:"image", blobId, …}`), so this
 * is the only place the transcript turns one back into pixels. Without it a
 * pasted screenshot is invisible on the way in and only the model can see it,
 * which makes the run impossible to read back later.
 */
import type { ReactNode } from "react";
import type { ImagePart } from "@daydream-code/shared";
import { BlobImage } from "./BlobImage.js";

/**
 * The image parts of a journal payload.
 *
 * A payload is `unknown` by the time it reaches a view — it round-tripped
 * through JSON and was written by whichever driver ran — so the shape is
 * checked rather than asserted.
 */
export function imageParts(value: unknown): ImagePart[] {
  if (!Array.isArray(value)) return [];
  const parts: ImagePart[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (record.type !== "image") continue;
    if (typeof record.blobId !== "string" || record.blobId.length === 0) continue;
    parts.push({
      type: "image",
      blobId: record.blobId,
      mediaType:
        typeof record.mediaType === "string" ? record.mediaType : "image/png",
      ...(typeof record.width === "number" ? { width: record.width } : {}),
      ...(typeof record.height === "number" ? { height: record.height } : {}),
      ...(typeof record.alt === "string" ? { alt: record.alt } : {}),
    });
  }
  return parts;
}

export function Attachments(props: { images: ImagePart[] }): ReactNode {
  if (props.images.length === 0) return null;
  return (
    <div className="entry-images">
      {props.images.map((image) => (
        <span
          key={image.blobId}
          className="entry-image"
          title={
            image.width !== undefined && image.height !== undefined
              ? `${image.mediaType} · ${image.width}×${image.height}`
              : image.mediaType
          }
        >
          <BlobImage
            blobId={image.blobId}
            alt="attached image"
            {...(image.width !== undefined ? { width: image.width } : {})}
            {...(image.height !== undefined ? { height: image.height } : {})}
          />
        </span>
      ))}
    </div>
  );
}
