import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { Readable } from "node:stream";
import { db, media } from "@cadmus/db";
import { getStagingStorageProvider } from "./media.js";
import { verifyMediaStreamToken } from "../lib/media-stream-token.js";

// Token-authenticated proxy for private staging media (video/PDF awaiting
// manual review). Mounted OUTSIDE the bearer-auth /api/admin/* prefix because a
// <video>/<img>/<a> tag can't send an Authorization header; authorization is
// the short-lived signed token in ?t=. Streams bytes from GCS with the SA
// access token (no signBlob — reliable on Cloud Run) and supports HTTP Range
// so video seeking works.
export const mediaStreamRoutes = new Hono();

function parseRange(header?: string): { start: number; end?: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : undefined;
  if (end != null && end < start) return null;
  return { start, end };
}

mediaStreamRoutes.get("/:id", async (c) => {
  const id = c.req.param("id");
  const token = c.req.query("t");
  if (!token) return c.json({ error: "Missing token" }, 401);

  const payload = await verifyMediaStreamToken(token);
  if (!payload || payload.mediaId !== id) {
    return c.json({ error: "Invalid or expired token" }, 401);
  }

  const [item] = await db
    .select({ stagingPath: media.stagingPath })
    .from(media)
    .where(eq(media.id, id));
  if (!item || !item.stagingPath) return c.json({ error: "Not found" }, 404);

  const stg = getStagingStorageProvider();
  if (!stg) return c.json({ error: "Staging storage not configured" }, 503);

  const range = parseRange(c.req.header("range"));
  let obj;
  try {
    obj = await stg.streamObject(item.stagingPath, range ?? undefined);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("No such object")) return c.json({ error: "File no longer available" }, 410);
    throw err;
  }

  const webStream = Readable.toWeb(obj.stream) as ReadableStream;

  if (range) {
    const start = range.start;
    const end = range.end ?? obj.size - 1;
    return c.body(webStream, 206, {
      "Content-Type": obj.contentType,
      "Content-Range": `bytes ${start}-${end}/${obj.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": String(end - start + 1),
      "Cache-Control": "private, no-store",
    });
  }

  return c.body(webStream, 200, {
    "Content-Type": obj.contentType,
    "Accept-Ranges": "bytes",
    "Content-Length": String(obj.size),
    "Cache-Control": "private, no-store",
  });
});
