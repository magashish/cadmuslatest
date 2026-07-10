import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db, importJobs, subscriptions, paymentMethods } from "@cadmus/db";
import { requireRole } from "../middleware/auth.js";
import { getStorageProvider } from "./media.js";
import { parseWxr, runImport } from "../lib/wordpress-importer.js";
import type { SiteEnv } from "../middleware/tenant.js";
import type { AuthUser } from "@cadmus/shared";
import type { ImportOptions } from "../lib/wordpress-importer.js";
import { htmlImportRoutes } from "./import-html.js";

export const importRoutes = new Hono<SiteEnv & { Variables: { user: AuthUser } }>();

// Mount HTML import sub-routes
importRoutes.route("/", htmlImportRoutes);

// Store raw XML buffers keyed by jobId. Lives only in-process — if the
// instance restarts between analyze and start the job will be in 'analyzing'
// status forever (known accepted limitation).
const xmlBufferStore = new Map<string, Buffer>();

// Analyze a WXR file — parse it, store metadata in an importJob, return summary.
importRoutes.post(
  "/wordpress/analyze",
  requireRole("owner", "admin"),
  async (c) => {
    const siteId = c.get("site")?.siteId;
    if (!siteId) return c.json({ error: "Site context is required" }, 400);

    const user = c.get("user");
    let formData: FormData;
    try {
      formData = await c.req.formData();
    } catch {
      return c.json({ error: "Failed to read upload. The file may be too large or the request was interrupted." }, 400);
    }
    const file = formData.get("file") as File | null;

    if (!file) return c.json({ error: "file is required" }, 400);
    if (!file.name.toLowerCase().endsWith(".xml")) {
      return c.json({ error: "File must be an XML file (.xml)" }, 400);
    }

    // 25 MB cap — Cloud Run has a 32 MB hard request body limit
    const MAX_BYTES = 25 * 1024 * 1024;
    if (file.size > MAX_BYTES) {
      return c.json({ error: "File is too large. Maximum size is 25 MB. For larger exports, split your WXR file by content type (posts, pages, media) using WordPress's export options." }, 413);
    }

    const [job] = await db
      .insert(importJobs)
      .values({ siteId, status: "analyzing", options: {} })
      .returning();

    try {
      const buffer = Buffer.from(await file.arrayBuffer());
      const parsed = await parseWxr(buffer);

      const postCount = parsed.items.filter((i) => i.postType === "post").length;
      const pageCount = parsed.items.filter((i) => i.postType === "page").length;
      const attachmentCount = parsed.items.filter((i) => i.postType === "attachment").length;

      // Store full parsed data in-memory; only lightweight metadata goes to DB.
      xmlBufferStore.set(job.id, buffer);

      await db
        .update(importJobs)
        .set({
          status: "pending",
          total: postCount + pageCount + attachmentCount,
          options: {
            authors: parsed.authors,
            categories: parsed.categories,
            tags: parsed.tags,
          } as Record<string, unknown>,
          updatedAt: new Date(),
        })
        .where(eq(importJobs.id, job.id));

      return c.json({
        jobId: job.id,
        postCount,
        pageCount,
        attachmentCount,
        authors: parsed.authors,
        categories: parsed.categories,
        tags: parsed.tags,
        hasMedia: attachmentCount > 0,
      });
    } catch (err) {
      await db
        .update(importJobs)
        .set({ status: "failed", result: { error: "Failed to parse XML" }, updatedAt: new Date() })
        .where(eq(importJobs.id, job.id));

      console.error("[import] analyze failed:", err);
      return c.json({ error: "Failed to parse WordPress export file. Make sure it is a valid WXR XML file." }, 422);
    }
  },
);

// Start an import job. Requires a payment method on file (like custom domains).
importRoutes.post(
  "/wordpress/start",
  requireRole("owner", "admin"),
  async (c) => {
    const siteId = c.get("site")?.siteId;
    if (!siteId) return c.json({ error: "Site context is required" }, 400);

    const user = c.get("user");
    const body = await c.req.json() as { jobId: string; options: ImportOptions };
    const { jobId, options } = body;

    if (!jobId || !options) return c.json({ error: "jobId and options are required" }, 400);

    // Payment method gate
    const [sub] = await db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(eq(subscriptions.siteId, siteId));

    if (sub) {
      const [pm] = await db
        .select({ id: paymentMethods.id })
        .from(paymentMethods)
        .where(and(eq(paymentMethods.subscriptionId, sub.id), eq(paymentMethods.isDefault, true)));

      if (!pm) {
        return c.json(
          { error: "A payment method is required to use the importer. Add one in the Account section." },
          402,
        );
      }
    } else {
      // No subscription at all (should not happen for standard sites, but be safe)
      return c.json(
        { error: "A payment method is required to use the importer. Add one in the Account section." },
        402,
      );
    }

    const [job] = await db
      .select()
      .from(importJobs)
      .where(and(eq(importJobs.id, jobId), eq(importJobs.siteId, siteId)));

    if (!job) return c.json({ error: "Import job not found" }, 404);
    if (job.status !== "pending") {
      return c.json({ error: `Job is not in pending state (current: ${job.status})` }, 409);
    }

    const xmlBuffer = xmlBufferStore.get(jobId);
    if (!xmlBuffer) return c.json({ error: "Import session expired. Please re-upload the file and analyze again." }, 422);

    const storage = getStorageProvider();
    if (options.importMedia && !storage) {
      return c.json({ error: "Storage provider not configured; media import unavailable." }, 503);
    }

    await db
      .update(importJobs)
      .set({ status: "running", options: options as unknown as Record<string, unknown>, updatedAt: new Date() })
      .where(eq(importJobs.id, jobId));

    // Fire and forget — re-parse from buffer so the background job has full content
    parseWxr(xmlBuffer)
      .then((parsed) => {
        xmlBufferStore.delete(jobId); // free memory once parsing starts
        return runImport(jobId, siteId, parsed, options, user.id, storage);
      })
      .catch((err) => {
        console.error(`[import] runImport error for job ${jobId}:`, err);
      });

    return c.json({ jobId });
  },
);

// Poll job status
importRoutes.get("/jobs/:jobId", requireRole("owner", "admin"), async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) return c.json({ error: "Site context is required" }, 400);

  const jobId = c.req.param("jobId");
  const [job] = await db
    .select()
    .from(importJobs)
    .where(and(eq(importJobs.id, jobId), eq(importJobs.siteId, siteId)));

  if (!job) return c.json({ error: "Job not found" }, 404);

  return c.json({
    id: job.id,
    status: job.status,
    progress: job.progress,
    total: job.total,
    result: job.result,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  });
});
