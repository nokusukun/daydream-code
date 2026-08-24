/**
 * An image that lives in the blob store, drawn wherever a blob id turns up:
 * a pending chip in a composer, and an attachment in the transcript.
 *
 * The bytes come back over the same authenticated JSON API as everything else
 * rather than from a plain `<img src="http://…/api/blobs/…">`. An `<img>` sends
 * no bearer token, so that URL would have to be public — the blob store holds
 * screenshots of whatever you were looking at, and making it the one
 * unauthenticated surface next to `/health` is not a trade worth a shorter
 * component.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError } from "../api.js";
import { blobDataUrl } from "../attachments.js";
import { useHarness } from "../harness.js";

export function BlobImage(props: {
  blobId: string;
  alt?: string | undefined;
  width?: number | undefined;
  height?: number | undefined;
  className?: string;
  /** Called once when the store says these bytes are gone (404), never on a
   *  network failure — the caller uses it to retire a stale attachment. */
  onMissing?: () => void;
}): ReactNode {
  const { api } = useHarness();
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Kept in a ref so a caller passing an inline arrow does not re-fetch on
  // every render of its parent.
  const onMissing = useRef(props.onMissing);
  onMissing.current = props.onMissing;

  useEffect(() => {
    let live = true;
    setSrc(null);
    setError(null);
    blobDataUrl(api, props.blobId)
      .then((url) => {
        if (live) setSrc(url);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setError(e instanceof ApiError && e.status === 404 ? "gone" : "failed");
        if (e instanceof ApiError && e.status === 404) onMissing.current?.();
      });
    return () => {
      live = false;
    };
  }, [api, props.blobId]);

  const className = props.className ?? "blob-image";
  // Reserve the space the image will take, so a transcript does not jump as
  // thumbnails arrive. Only possible when the header gave us dimensions.
  const ratio =
    props.width !== undefined && props.height !== undefined && props.height > 0
      ? { aspectRatio: `${props.width} / ${props.height}` }
      : undefined;

  if (error !== null) {
    return (
      <span
        className={`${className} blob-image-error`}
        title={
          error === "gone"
            ? "these bytes are no longer in the blob store"
            : "could not read this image from the blob store"
        }
      >
        {error === "gone" ? "image gone" : "image unavailable"}
      </span>
    );
  }
  if (src === null) {
    return (
      <span
        className={`${className} blob-image-pending`}
        style={ratio}
        aria-hidden="true"
      />
    );
  }
  return (
    <img
      className={className}
      src={src}
      alt={props.alt ?? "attached image"}
      style={ratio}
    />
  );
}
