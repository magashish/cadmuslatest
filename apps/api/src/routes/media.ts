import { Hono } from "hono";
import { eq, and, sql, desc, sum, ne } from "drizzle-orm";
import { db, media, contentMedia, auditLog, subscriptions, sites } from "@cadmus/db";
import type { StorageProvider } from "@cadmus/cloud";
import type { SiteEnv } from "../middleware/tenant.js";
import { optimizeImage } from "../lib/image-optimization.js";
import { sanitizeSvg } from "../lib/sanitize-html-block.js";
import { requireRole } from "../middleware/auth.js";
import type { AuthUser } from "@cadmus/shared";
import { fileTypeFromBuffer } from "file-type";
import { getAIRouter } from "./ai.js";
import { checkFeatureGate } from "../lib/feature-gates.js";

// Storage provider injected at app startup
let storage: StorageProvider | null = null;

export function setStorageProvider(provider: StorageProvider) {
  storage = provider;
}

export function getStorageProvider(): StorageProvider | null {
  return storage;
}

// Staging storage provider injected at app startup (for video moderation)
let stagingStorage: StorageProvider | null = null;

export function setStagingStorageProvider(provider: StorageProvider) {
  stagingStorage = provider;
}

export function getStagingStorageProvider(): StorageProvider | null {
  return stagingStorage;
}

type ModerationDecision = "approved" | "review" | "blocked";

async function scanImageWithVision(buffer: Buffer): Promise<{ decision: ModerationDecision; scores: Record<string, string> }> {
  const { ImageAnnotatorClient } = await import("@google-cloud/vision");
  const client = new ImageAnnotatorClient();
  const [result] = await client.safeSearchDetection({ image: { content: buffer } });
  const safe = result.safeSearchAnnotation;
  const scores: Record<string, string> = {
    adult: String(safe?.adult ?? "UNKNOWN"),
    violence: String(safe?.violence ?? "UNKNOWN"),
    racy: String(safe?.racy ?? "UNKNOWN"),
    medical: String(safe?.medical ?? "UNKNOWN"),
    spoof: String(safe?.spoof ?? "UNKNOWN"),
  };
  const blockedVals = ["LIKELY", "VERY_LIKELY"];
  const reviewVals = ["POSSIBLE"];
  const isBlocked = blockedVals.includes(scores.adult) || blockedVals.includes(scores.violence);
  const isReview = !isBlocked && (reviewVals.includes(scores.adult) || reviewVals.includes(scores.violence) || reviewVals.includes(scores.racy));
  return { decision: isBlocked ? "blocked" : isReview ? "review" : "approved", scores };
}

async function enqueueMediaScan(mediaId: string, siteId: string): Promise<void> {
  const scannerUrl = process.env.SCANNER_SERVICE_URL;
  const cloudTasksQueue = process.env.CLOUD_TASKS_QUEUE;
  if (!scannerUrl || !cloudTasksQueue) {
    console.warn(`Scanner not configured — auto-approving video media ${mediaId}`);
    const { db: dbInner, media: mediaTable } = await import("@cadmus/db");
    const { eq: eqInner } = await import("drizzle-orm");
    await dbInner.update(mediaTable).set({ moderationStatus: "approved" }).where(eqInner(mediaTable.id, mediaId));
    return;
  }
  const { GoogleAuth } = await import("google-auth-library");
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-tasks"] });
  const client = await auth.getClient();
  const token = await (client as { getAccessToken(): Promise<{ token: string }> }).getAccessToken();
  await fetch(`https://cloudtasks.googleapis.com/v2/${cloudTasksQueue}/tasks`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      task: {
        httpRequest: {
          url: `${scannerUrl}/scan`,
          httpMethod: "POST",
          headers: { "Content-Type": "application/json" },
          body: Buffer.from(JSON.stringify({ mediaId, siteId })).toString("base64"),
          oidcToken: { serviceAccountEmail: process.env.SCANNER_SA_EMAIL },
        },
      },
    }),
  });
}

async function generateAltText(imageUrl: string): Promise<string | null> {
  const router = getAIRouter();
  if (!router) return null;
  try {
    const result = await router.analyzeImage({
      imageUrl,
      prompt: "Write a concise alt text description for this image (under 125 characters). Describe what is shown factually. If it is a logo or icon, identify it as such.",
    });
    return result.text?.trim() || null;
  } catch {
    return null;
  }
}

// Per-file upload limits by billing tier
const TRIAL_UPLOAD_LIMIT = 100 * 1024 * 1024;   // 100 MB
const DEFAULT_UPLOAD_LIMIT = 500 * 1024 * 1024;  // 500 MB

// Per-site total storage quota
const SITE_STORAGE_QUOTA = 5 * 1024 * 1024 * 1024; // 5 GB

// Allowed MIME type categories — no executables, archives, scripts, etc.
function isAllowedMimeType(mime: string): boolean {
  return mime.startsWith("image/") || mime.startsWith("video/") || mime === "application/pdf";
}

// User-uploaded media is mutable conceptually (the user can delete and replace
// at the same media id), but in practice each upload writes a new timestamped
// path — so a 1-week cache is safe and gives CDNs/browsers a long hit window.
const USER_MEDIA_CACHE = "public, max-age=604800";

export const mediaRoutes = new Hono<SiteEnv & { Variables: { user: AuthUser } }>();

// List media for a site
mediaRoutes.get("/", async (c) => {
  const siteId = c.get("site").siteId;
  const mimeFilter = c.req.query("mime"); // e.g. "image" to match image/*
  const limit = Math.min(Number(c.req.query("limit")) || 50, 100);
  const offset = Number(c.req.query("offset")) || 0;

  const excludeBlocked = c.req.query("excludeBlocked") === "true";
  const conditions = [
    eq(media.siteId, siteId),
    ne(media.moderationStatus, "pending"),
    ...(excludeBlocked ? [ne(media.moderationStatus, "blocked")] : []),
  ];
  if (mimeFilter) {
    if (mimeFilter.includes("/")) {
      conditions.push(eq(media.mimeType, mimeFilter));
    } else {
      conditions.push(sql`${media.mimeType} LIKE ${mimeFilter + "/%"}`);
    }
  }

  const [items, countResult] = await Promise.all([
    db
      .select()
      .from(media)
      .where(and(...conditions))
      .orderBy(desc(media.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)` })
      .from(media)
      .where(and(...conditions)),
  ]);

  return c.json({ items, total: Number(countResult[0].count) });
});

// Storage usage + limits for this site (for the account-screen quota display).
// Registered before /:id so the static path isn't captured by the param route.
mediaRoutes.get("/usage", async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) return c.json({ error: "Site context is required" }, 400);

  const [row] = await db
    .select({ used: sum(media.fileSize), count: sql<number>`count(*)` })
    .from(media)
    .where(eq(media.siteId, siteId));
  const [sub] = await db
    .select({ status: subscriptions.status })
    .from(subscriptions)
    .where(eq(subscriptions.siteId, siteId))
    .limit(1);
  const isTrialing = sub?.status === "trialing";

  return c.json({
    usedBytes: Number(row?.used ?? 0),
    quotaBytes: SITE_STORAGE_QUOTA,
    fileCount: Number(row?.count ?? 0),
    uploadLimitBytes: isTrialing ? TRIAL_UPLOAD_LIMIT : DEFAULT_UPLOAD_LIMIT,
  });
});

// Get single media item
mediaRoutes.get("/:id", async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) {
    return c.json({ error: "Site context is required" }, 400);
  }
  const id = c.req.param("id");

  const [item] = await db
    .select()
    .from(media)
    .where(and(eq(media.id, id), eq(media.siteId, siteId)));
  if (!item) {
    return c.json({ error: "Media not found" }, 404);
  }

  return c.json(item);
});

// Request a signed URL for direct-to-GCS video upload (bypasses 32 MB Cloud Run limit)
mediaRoutes.post("/upload-url", requireRole("editor", "admin", "owner"), async (c) => {
  if (!stagingStorage) {
    return c.json({ error: "Staging storage not configured" }, 503);
  }
  const siteId = c.get("site").siteId;
  const user = c.get("user");
  const { filename, mimeType, fileSize } = await c.req.json<{ filename: string; mimeType: string; fileSize: number }>();

  if (!mimeType?.startsWith("video/") && mimeType !== "application/pdf") {
    return c.json({ error: "Signed upload is only supported for video and PDF files" }, 400);
  }

  const [sub] = await db.select({ status: subscriptions.status }).from(subscriptions).where(eq(subscriptions.siteId, siteId)).limit(1);
  const isTrialing = sub?.status === "trialing";
  const maxUploadBytes = isTrialing ? TRIAL_UPLOAD_LIMIT : DEFAULT_UPLOAD_LIMIT;
  if (fileSize > maxUploadBytes) {
    if (isTrialing) return c.json({ error: "File exceeds the 100 MB limit for trial accounts.", code: "trial_limit_exceeded" }, 413);
    return c.json({ error: `File exceeds the ${Math.round(maxUploadBytes / (1024 * 1024))} MB upload limit.` }, 413);
  }

  const [usageRow] = await db.select({ used: sum(media.fileSize) }).from(media).where(eq(media.siteId, siteId));
  if (Number(usageRow?.used ?? 0) + fileSize > SITE_STORAGE_QUOTA) {
    return c.json({ error: "Storage quota exceeded.", code: "storage_quota_exceeded" }, 413);
  }

  const stagingPath = `staging/sites/${siteId}/media/${Date.now()}-${filename}`;
  // Resumable upload session (no signBlob — reliable on Cloud Run). The browser
  // PUTs directly to this URI; pass its Origin so GCS records it for CORS.
  const origin = c.req.header("origin") || undefined;
  const uploadUrl = await stagingStorage.createResumableUploadUrl(stagingPath, mimeType, origin);

  const [item] = await db.insert(media).values({
    siteId,
    filename,
    storageUrl: stagingStorage.getPublicUrl(stagingPath),
    mimeType,
    fileSize,
    variants: {},
    moderationStatus: "pending",
    moderationScores: {},
    stagingPath,
    uploadedBy: user.id,
  }).returning();

  await db.insert(auditLog).values({
    siteId,
    actorType: "user",
    actorId: user.id,
    action: "media.uploaded",
    entityType: "media",
    entityId: item.id,
    details: { filename, mimeType, size: fileSize, moderation: "pending" },
  });

  return c.json({ mediaId: item.id, uploadUrl, stagingPath });
});

// Called by client after direct-to-GCS upload completes — enqueues the scan job
mediaRoutes.post("/upload-complete/:id", requireRole("editor", "admin", "owner"), async (c) => {
  const siteId = c.get("site").siteId;
  const id = c.req.param("id");

  const [item] = await db.select().from(media).where(and(eq(media.id, id), eq(media.siteId, siteId)));
  if (!item) return c.json({ error: "Media not found" }, 404);
  if (item.moderationStatus !== "pending") return c.json({ error: "Media is not pending upload" }, 400);

  // The resumable session does not enforce the size the client declared at
  // /upload-url, so verify the ACTUAL uploaded bytes against the per-file
  // limit and storage quota before accepting it. Over-limit => discard.
  if (stagingStorage && item.stagingPath) {
    let actualSize: number;
    try {
      actualSize = await stagingStorage.getObjectSize(item.stagingPath);
    } catch {
      return c.json({ error: "Uploaded file not found in storage." }, 400);
    }

    const [sub] = await db
      .select({ status: subscriptions.status })
      .from(subscriptions)
      .where(eq(subscriptions.siteId, siteId))
      .limit(1);
    const maxUploadBytes = sub?.status === "trialing" ? TRIAL_UPLOAD_LIMIT : DEFAULT_UPLOAD_LIMIT;
    const [usageRow] = await db
      .select({ used: sum(media.fileSize) })
      .from(media)
      .where(and(eq(media.siteId, siteId), ne(media.id, id)));
    const otherUsage = Number(usageRow?.used ?? 0);

    if (actualSize > maxUploadBytes || otherUsage + actualSize > SITE_STORAGE_QUOTA) {
      await stagingStorage.delete(item.stagingPath).catch(() => {});
      await db.delete(media).where(eq(media.id, id));
      const code = actualSize > maxUploadBytes ? "upload_limit_exceeded" : "storage_quota_exceeded";
      return c.json({ error: "Uploaded file exceeds the allowed size or storage quota.", code }, 413);
    }

    // Reconcile the stored size with what was actually uploaded.
    if (actualSize !== Number(item.fileSize)) {
      await db.update(media).set({ fileSize: actualSize }).where(eq(media.id, id));
      item.fileSize = actualSize;
    }
  }

  enqueueMediaScan(item.id, siteId).catch((err) =>
    console.error(`Failed to enqueue media scan for ${item.id}:`, err)
  );

  return c.json(item);
});

// Upload media
mediaRoutes.post("/upload", requireRole("editor", "admin", "owner"), async (c) => {
  if (!storage) {
    return c.json({ error: "Storage provider not configured" }, 503);
  }

  const siteId = c.get("site").siteId;
  const user = c.get("user");
  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;

  if (!file) {
    return c.json({ error: "file is required" }, 400);
  }

  // Determine per-file limit based on subscription status
  const [sub] = await db
    .select({ status: subscriptions.status })
    .from(subscriptions)
    .where(eq(subscriptions.siteId, siteId))
    .limit(1);
  const isTrialing = sub?.status === "trialing";
  const maxUploadBytes = isTrialing ? TRIAL_UPLOAD_LIMIT : DEFAULT_UPLOAD_LIMIT;

  if (file.size > maxUploadBytes) {
    if (isTrialing) {
      return c.json(
        {
          error: `File exceeds the 100 MB limit for trial accounts. Add a payment method to upload files up to 500 MB.`,
          code: "trial_limit_exceeded",
        },
        413,
      );
    }
    return c.json(
      { error: `File is too large. Maximum upload size is ${Math.round(maxUploadBytes / (1024 * 1024))} MB.` },
      413,
    );
  }

  // Feature gate: free-tier storage limit
  const storageGate = await checkFeatureGate(siteId, "storage_upload", { uploadBytes: file.size });
  if (!storageGate.allowed) {
    return c.json(
      {
        error: storageGate.reason || "Storage limit reached for free plan",
        gate: storageGate,
        code: "free_tier_storage_limit",
      },
      413,
    );
  }

  const rawBuffer = Buffer.from(await file.arrayBuffer());

  // Validate MIME type: check both the browser-reported type and the actual
  // file signature (magic bytes) to catch spoofed content-types.
  const claimedMime = file.type || "application/octet-stream";
  if (!isAllowedMimeType(claimedMime)) {
    return c.json(
      { error: `File type "${claimedMime}" is not allowed. Accepted types: images, videos, and PDFs.` },
      415,
    );
  }
  // SVG and PDF are text-based — file-type won't detect them, skip signature check.
  const skipSignatureCheck = claimedMime === "image/svg+xml" || claimedMime === "application/pdf";
  if (!skipSignatureCheck) {
    const detected = await fileTypeFromBuffer(rawBuffer);
    if (detected && !isAllowedMimeType(detected.mime)) {
      return c.json(
        { error: "File content does not match its declared type. Upload rejected." },
        415,
      );
    }
  }

  // Check per-site storage quota (5 GB)
  const [usageRow] = await db
    .select({ used: sum(media.fileSize) })
    .from(media)
    .where(eq(media.siteId, siteId));
  const usedBytes = Number(usageRow?.used ?? 0);
  if (usedBytes + file.size > SITE_STORAGE_QUOTA) {
    const usedGB = (usedBytes / (1024 ** 3)).toFixed(2);
    return c.json(
      {
        error: `Storage quota exceeded. You've used ${usedGB} GB of your 5 GB limit.`,
        code: "storage_quota_exceeded",
      },
      413,
    );
  }

  const fileType = claimedMime;

  // Optimize images (resize + convert to WebP/JPEG); non-images pass through unchanged
  const isImage = fileType.startsWith("image/") && fileType !== "image/svg+xml";
  const isVideo = fileType.startsWith("video/");

  // --- Image moderation via Cloud Vision (synchronous, before optimize) ---
  let imageModerationStatus: ModerationDecision = "approved";
  let imageModerationScores: Record<string, string> = {};
  if (isImage && process.env.GOOGLE_CLOUD_VISION_ENABLED === "true") {
    const { decision, scores } = await scanImageWithVision(rawBuffer);
    imageModerationStatus = decision;
    imageModerationScores = scores;
    if (decision === "blocked") {
      return c.json({ error: "File was rejected by content moderation." }, 422);
    }
  }

  const isPdf = fileType === "application/pdf";

  // --- Video + PDF moderation: upload to staging bucket for scanner ---
  if ((isVideo || isPdf) && stagingStorage) {
    const uploadFilename = file.name;
    const stagingPath = `staging/sites/${siteId}/media/${Date.now()}-${uploadFilename}`;
    const stagingResult = await stagingStorage.upload(rawBuffer, stagingPath, fileType);

    let item;
    try {
      item = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(media)
          .values({
            siteId,
            filename: uploadFilename,
            storageUrl: stagingResult.url,
            mimeType: fileType,
            fileSize: rawBuffer.length,
            variants: {},
            moderationStatus: "pending",
            moderationScores: {},
            stagingPath,
            uploadedBy: user.id,
          })
          .returning();

        await tx.insert(auditLog).values({
          siteId,
          actorType: "user",
          actorId: user.id,
          action: "media.uploaded",
          entityType: "media",
          entityId: created.id,
          details: { filename: file.name, mimeType: file.type, size: stagingResult.size, moderation: "pending" },
        });

        return created;
      });
    } catch (err) {
      try { await stagingStorage.delete(stagingPath); } catch {
        console.warn(`Failed to clean up staging file after failed DB insert: ${stagingPath}`);
      }
      throw err;
    }

    // Enqueue scan job after DB commit (fire-and-forget)
    enqueueMediaScan(item.id, siteId).catch((err) =>
      console.error(`Failed to enqueue media scan for ${item.id}:`, err)
    );

    return c.json(item, 201);
  }

  // --- Normal path (images and non-video non-image files) ---
  // SVG is served from the public bucket and can run script when opened directly,
  // so strip script/foreignObject/on*/javascript: before storing.
  const isSvg = fileType === "image/svg+xml";
  const optimized = isImage
    ? await optimizeImage(rawBuffer, fileType, { maxWidth: 1920 })
    : isSvg
      ? { buffer: Buffer.from(sanitizeSvg(rawBuffer.toString("utf8")), "utf8"), mimeType: fileType }
      : { buffer: rawBuffer, mimeType: fileType };

  // Adjust filename extension if format changed (e.g. PNG → WebP)
  let uploadFilename = file.name;
  if (isImage && optimized.mimeType !== fileType) {
    const newExt = optimized.mimeType === "image/webp" ? ".webp" : optimized.mimeType === "image/jpeg" ? ".jpg" : "";
    if (newExt) {
      uploadFilename = uploadFilename.replace(/\.[^.]+$/, newExt);
    }
  }

  const path = `sites/${siteId}/media/${Date.now()}-${uploadFilename}`;
  const result = await storage.upload(optimized.buffer, path, optimized.mimeType, USER_MEDIA_CACHE);

  const autoAltText = isImage ? await generateAltText(result.url) : null;

  let item;
  try {
    item = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(media)
        .values({
          siteId,
          filename: uploadFilename,
          storageUrl: result.url,
          mimeType: optimized.mimeType,
          fileSize: optimized.buffer.length,
          variants: {},
          moderationStatus: isImage ? imageModerationStatus : "approved",
          moderationScores: isImage ? imageModerationScores : {},
          stagingPath: null,
          uploadedBy: user.id,
          ...(autoAltText ? { aiAltText: autoAltText } : {}),
        })
        .returning();

      await tx.insert(auditLog).values({
        siteId,
        actorType: "user",
        actorId: user.id,
        action: "media.uploaded",
        entityType: "media",
        entityId: created.id,
        details: { filename: file.name, mimeType: file.type, size: result.size },
      });

      return created;
    });
  } catch (err) {
    // DB insert failed — best-effort cleanup of uploaded file
    try {
      await storage.delete(path);
    } catch {
      console.warn(`Failed to clean up storage file after failed DB insert: ${path}`);
    }
    throw err;
  }

  return c.json(item, 201);
});

// Update media metadata (alt text, tags, filename)
mediaRoutes.put("/:id", requireRole("editor", "admin", "owner"), async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) {
    return c.json({ error: "Site context is required" }, 400);
  }
  const id = c.req.param("id");
  const user = c.get("user");
  const body = await c.req.json();
  const { aiAltText, aiTags, filename } = body;

  const [existing] = await db
    .select()
    .from(media)
    .where(and(eq(media.id, id), eq(media.siteId, siteId)));
  if (!existing) {
    return c.json({ error: "Media not found" }, 404);
  }

  const updates: Record<string, unknown> = {};
  if (aiAltText !== undefined) updates.aiAltText = aiAltText;
  if (aiTags !== undefined) updates.aiTags = aiTags;
  if (filename !== undefined) updates.filename = filename;

  const [updated] = await db
    .update(media)
    .set(updates)
    .where(eq(media.id, id))
    .returning();

  await db.insert(auditLog).values({
    siteId: existing.siteId,
    actorType: "user",
    actorId: user.id,
    action: "media.updated",
    entityType: "media",
    entityId: id,
    details: { changes: Object.keys(updates) },
  });

  return c.json(updated);
});

// Delete media
mediaRoutes.delete("/:id", requireRole("editor", "admin", "owner"), async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) {
    return c.json({ error: "Site context is required" }, 400);
  }
  const id = c.req.param("id");
  const user = c.get("user");

  const [existing] = await db
    .select()
    .from(media)
    .where(and(eq(media.id, id), eq(media.siteId, siteId)));
  if (!existing) {
    return c.json({ error: "Media not found" }, 404);
  }

  await db.transaction(async (tx) => {
    await tx.delete(contentMedia).where(eq(contentMedia.mediaId, id));
    await tx.delete(media).where(eq(media.id, id));

    await tx.insert(auditLog).values({
      siteId: existing.siteId,
      actorType: "user",
      actorId: user.id,
      action: "media.deleted",
      entityType: "media",
      entityId: id,
      details: { filename: existing.filename },
    });
  });

  // Delete from storage after DB commit — orphaned files are preferable to lost DB records
  if (existing.moderationStatus === "pending" && existing.stagingPath && stagingStorage) {
    try {
      await stagingStorage.delete(existing.stagingPath);
    } catch {
      console.warn(`Failed to delete staging file for media ${id}`);
    }
  } else if (storage) {
    try {
      // Derive the object key from the provider's own public-URL scheme
      // (getPublicUrl("") yields the "https://host/bucket/" prefix). The old
      // host-only strip left the bucket name in the key, so deletes silently
      // no-op'd and leaked orphaned objects.
      const publicPrefix = storage.getPublicUrl("");
      const storagePath = existing.storageUrl.startsWith(publicPrefix)
        ? existing.storageUrl.slice(publicPrefix.length)
        : new URL(existing.storageUrl).pathname.replace(/^\/+/, "");
      await storage.delete(storagePath);
    } catch {
      console.warn(`Failed to delete storage file for media ${id}`);
    }
  }

  return c.json({ deleted: true });
});

// Get media linked to a specific content item
mediaRoutes.get("/by-content/:contentId", async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) {
    return c.json({ error: "Site context is required" }, 400);
  }
  const contentId = c.req.param("contentId");

  const items = await db
    .select({
      media: media,
      context: contentMedia.context,
    })
    .from(contentMedia)
    .innerJoin(media, eq(contentMedia.mediaId, media.id))
    .where(and(eq(contentMedia.contentId, contentId), eq(media.siteId, siteId)));

  return c.json({ items });
});
