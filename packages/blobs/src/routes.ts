import { z } from "zod";
import type { Context } from "@daydream-code/kernel";
import { HttpError, type RouteRequest } from "@daydream-code/routes";
import type {} from "./index.js";

const UploadBody = z.object({
  /** Raw base64, no data-URL prefix — the media type is sniffed, not declared. */
  data: z.string(),
  /** Original filename when there is one; a clipboard paste has none. */
  alt: z.string().optional(),
});

/**
 * Consumer plugin: the blob store's HTTP surface.
 *
 * Two routes, and the pair is what lets a client attach an image before it
 * sends anything. A composer uploads on paste and then carries a blob id —
 * roughly nothing — instead of megabytes of base64 held in the renderer and
 * re-posted on every attempt. The id is content-addressed, so pasting the same
 * screenshot into three composers costs one copy on disk, and a draft that
 * survives a reload can point at bytes that outlived the window.
 *
 * Both routes speak base64 in JSON because a route handler's return value *is*
 * the JSON body — the seam has no reply object, deliberately, so that a
 * capability package cannot be written against one transport. That costs a
 * third of the wire size on a payload that is local and already on disk, which
 * is a better trade than teaching every capability package about streams.
 */
const blobRoutes = {
  name: "blob-routes",
  inject: ["routes", "blobs"],
  apply(ctx: Context) {
    ctx.routes.registerAll(ctx, [
      {
        method: "POST",
        path: "/api/blobs",
        handle: (req: RouteRequest) => {
          const body = UploadBody.parse(req.body);
          const bytes = Buffer.from(body.data, "base64");
          if (bytes.length === 0) {
            throw new HttpError(400, "attachment is empty");
          }
          try {
            return ctx.blobs.put(bytes, body.alt);
          } catch (error) {
            // Over the size limit, or not an image at all. Both are the
            // client's doing and both are recoverable by picking another
            // file, so they are a 400 rather than the 500 an escaping throw
            // would otherwise become.
            throw new HttpError(400, String((error as Error).message ?? error));
          }
        },
      },
      {
        method: "GET",
        path: "/api/blobs/:id",
        handle: (req: RouteRequest) => {
          const id = req.params.id!;
          const ref = ctx.blobs.stat(id);
          // A 404 rather than an empty body: a stale draft chip pointing at
          // bytes that are gone has to be able to tell that apart from a blob
          // that is merely still uploading, and drop itself before send.
          if (ref === undefined) throw new HttpError(404, `unknown blob: ${id}`);
          return { ...ref, data: ctx.blobs.read(id).toString("base64") };
        },
      },
    ]);
  },
};

export default blobRoutes;
