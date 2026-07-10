import { Hono } from "hono";
import { eq, and, ne, sql, desc, inArray } from "drizzle-orm";
import { db, content, contentBlocks, contentVersions, contentMedia, media, auditLog, users } from "@cadmus/db";
import type { SiteEnv, SiteContext } from "../middleware/tenant.js";
import type { CdnCacheProvider } from "@cadmus/cloud";
import { signPreviewToken } from "../lib/preview.js";
import { getSiteUrl } from "../lib/urls.js";
import { ensureFormIds } from "../lib/form-ids.js";
import { sanitizeHtmlBlock } from "../lib/sanitize-html-block.js";

// Strip script/event-handler/javascript: payloads from html-block markup before
// it is stored. Mutates each block's data.html in place (mirrors ensureFormIds).
function sanitizeHtmlBlocks(blocks: Array<{ blockType?: string; data?: unknown }>): void {
  for (const block of blocks) {
    if (block?.blockType !== "html") continue;
    const data = block.data as { html?: unknown } | undefined;
    if (data && typeof data.html === "string") {
      data.html = sanitizeHtmlBlock(data.html);
    }
  }
}
import { recompileSiteCss } from "../lib/theme-recompile.js";
import { requireRole } from "../middleware/auth.js";
import { checkFeatureGate } from "../lib/feature-gates.js";
import type { AuthUser } from "@cadmus/shared";

// ── CDN cache purge ─────────────────────────────────────────────────────────

let cdnCacheProvider: CdnCacheProvider | null = null;

export function setCdnCacheProvider(provider: CdnCacheProvider) {
  cdnCacheProvider = provider;
}

function purgeContentCache(site: SiteContext, slug: string, type: string) {
  if (!cdnCacheProvider) return;

  const path = slug === "home" ? "/" : type === "post" ? `/blog/${slug}` : `/${slug}`;
  const urls = [`${getSiteUrl(site.subdomain)}${path}`];
  if (site.domain) {
    urls.push(`https://${site.domain}${path}`);
  }

  cdnCacheProvider.purgeUrls(urls).catch((err) => {
    console.error("[cdn-cache] Purge failed:", err);
  });
}

export const contentRoutes = new Hono<SiteEnv & { Variables: { user: AuthUser } }>();

// List content with filtering
contentRoutes.get("/", async (c) => {
  const siteId = c.get("site")?.siteId;
  const type = c.req.query("type");
  const status = c.req.query("status");
  const limit = Math.min(Number(c.req.query("limit")) || 50, 100);
  const offset = Number(c.req.query("offset")) || 0;

  if (!siteId) {
    return c.json({ error: "Site context is required" }, 400);
  }

  const conditions = [eq(content.siteId, siteId)];
  if (type) conditions.push(eq(content.type, type));
  if (status) conditions.push(eq(content.status, status));

  const [items, countResult] = await Promise.all([
    db
      .select()
      .from(content)
      .where(and(...conditions))
      .orderBy(desc(content.updatedAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)` })
      .from(content)
      .where(and(...conditions)),
  ]);

  return c.json({ items, total: Number(countResult[0].count) });
});

// Get single content item with blocks
contentRoutes.get("/:id", async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) {
    return c.json({ error: "Site context is required" }, 400);
  }
  const id = c.req.param("id");

  const [item] = await db
    .select()
    .from(content)
    .where(and(eq(content.id, id), eq(content.siteId, siteId)));
  if (!item) {
    return c.json({ error: "Content not found" }, 404);
  }

  const blocks = await db
    .select()
    .from(contentBlocks)
    .where(eq(contentBlocks.contentId, id))
    .orderBy(contentBlocks.position);

  return c.json({ ...item, blocks });
});

// Create content with blocks
contentRoutes.post("/", requireRole("editor", "admin", "owner"), async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) {
    return c.json({ error: "Site context is required" }, 400);
  }

  const user = c.get("user");
  const body = await c.req.json();
  const { type, slug, status: contentStatus, schemaData, blocks, skipRecompile } = body;

  if (!type || !slug) {
    return c.json({ error: "type and slug are required" }, 400);
  }

  // Feature gate: free-tier content count limits
  if (type === "page" || type === "post") {
    const gate = await checkFeatureGate(siteId, type === "page" ? "page_count" : "post_count");
    if (!gate.allowed) {
      return c.json({ error: gate.reason || `${type} limit reached on the free plan`, gate }, 403);
    }
  }

  // Prevent duplicate slugs within the same site — archived pages don't block reuse
  const [existingSlug] = await db
    .select({ id: content.id })
    .from(content)
    .where(and(eq(content.siteId, siteId), eq(content.slug, slug), eq(content.type, type), ne(content.status, "archived")));
  if (existingSlug) {
    return c.json({ error: `A ${type} with slug "${slug}" already exists` }, 409);
  }

  const item = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(content)
      .values({
        siteId,
        type,
        slug,
        status: contentStatus || "draft",
        schemaData: schemaData || {},
        createdBy: user.id,
        publishedAt: contentStatus === "published" ? new Date() : null,
      })
      .returning();

    if (blocks?.length) {
      ensureFormIds(blocks);
      sanitizeHtmlBlocks(blocks);
      await tx.insert(contentBlocks).values(
        blocks.map((block: { blockType: string; data: unknown }, i: number) => ({
          contentId: created.id,
          position: i,
          blockType: block.blockType,
          data: block.data || {},
        }))
      );
    }

    await tx.insert(contentVersions).values({
      contentId: created.id,
      version: 1,
      schemaData: created.schemaData,
      blocksSnapshot: blocks || [],
      createdBy: user.id,
    });

    await tx.insert(auditLog).values({
      siteId,
      actorType: "user",
      actorId: user.id,
      action: "content.created",
      entityType: "content",
      entityId: created.id,
      details: { type, slug, status: created.status },
    });

    return created;
  });

  const createdBlocks = await db
    .select()
    .from(contentBlocks)
    .where(eq(contentBlocks.contentId, item.id))
    .orderBy(contentBlocks.position);

  if (blocks?.length && !skipRecompile) {
    await recompileSiteCss(siteId);
  }

  if (item.status === "published") {
    purgeContentCache(c.get("site"), item.slug, item.type);
  }

  return c.json({ ...item, blocks: createdBlocks }, 201);
});

// Update content (creates new version)
contentRoutes.put("/:id", requireRole("editor", "admin", "owner"), async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) {
    return c.json({ error: "Site context is required" }, 400);
  }
  const id = c.req.param("id");
  const user = c.get("user");
  const body = await c.req.json();
  const { slug, status: newStatus, schemaData, blocks } = body;

  const [existing] = await db
    .select()
    .from(content)
    .where(and(eq(content.id, id), eq(content.siteId, siteId)));
  if (!existing) {
    return c.json({ error: "Content not found" }, 404);
  }

  // Build update fields — only include fields that actually changed
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  const actualChanges: string[] = [];
  if (slug !== undefined && slug !== existing.slug) {
    const [conflict] = await db
      .select({ id: content.id })
      .from(content)
      .where(and(
        eq(content.siteId, siteId),
        eq(content.slug, slug),
        eq(content.type, existing.type),
        ne(content.id, id),
        ne(content.status, "archived"),
      ))
      .limit(1);
    if (conflict) {
      return c.json({ error: `A ${existing.type} with slug "${slug}" already exists` }, 409);
    }
    updates.slug = slug;
    actualChanges.push("slug");
  }
  if (schemaData !== undefined && JSON.stringify(schemaData) !== JSON.stringify(existing.schemaData)) {
    updates.schemaData = schemaData;
    actualChanges.push("schemaData");
  }
  if (newStatus !== undefined && newStatus !== existing.status) {
    updates.status = newStatus;
    actualChanges.push("status");
    if (newStatus === "published" && !existing.publishedAt) {
      updates.publishedAt = new Date();
    }
  }

  const { updated, currentBlocks } = await db.transaction(async (tx) => {
    const [upd] = await tx
      .update(content)
      .set(updates)
      .where(eq(content.id, id))
      .returning();

    if (blocks !== undefined) {
      await tx.delete(contentBlocks).where(eq(contentBlocks.contentId, id));
      if (blocks.length) {
        ensureFormIds(blocks);
        sanitizeHtmlBlocks(blocks);
        await tx.insert(contentBlocks).values(
          blocks.map((block: { blockType: string; data: unknown }, i: number) => ({
            contentId: id,
            position: i,
            blockType: block.blockType,
            data: block.data || {},
          }))
        );
      }
    }

    const [maxVersion] = await tx
      .select({ max: sql<number>`coalesce(max(${contentVersions.version}), 0)` })
      .from(contentVersions)
      .where(eq(contentVersions.contentId, id));

    const blks = await tx
      .select()
      .from(contentBlocks)
      .where(eq(contentBlocks.contentId, id))
      .orderBy(contentBlocks.position);

    await tx.insert(contentVersions).values({
      contentId: id,
      version: Number(maxVersion.max) + 1,
      schemaData: upd.schemaData,
      blocksSnapshot: blks,
      createdBy: user.id,
    });

    await tx.insert(auditLog).values({
      siteId: existing.siteId,
      actorType: "user",
      actorId: user.id,
      action: "content.updated",
      entityType: "content",
      entityId: id,
      details: {
        slug: existing.slug,
        title: (existing.schemaData as Record<string, unknown>)?.title,
        ...(actualChanges.length > 0 ? { changes: actualChanges } : {}),
        ...(blocks !== undefined ? { blocksUpdated: true } : {}),
      },
    });

    return { updated: upd, currentBlocks: blks };
  });

  if (blocks !== undefined) {
    await recompileSiteCss(siteId);
  }

  const isPublished = updated.status === "published" || existing.status === "published";
  if (isPublished) {
    purgeContentCache(c.get("site"), updated.slug, updated.type);
  }

  return c.json({ ...updated, blocks: currentBlocks });
});

// Soft delete (archive)
contentRoutes.delete("/:id", requireRole("editor", "admin", "owner"), async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) {
    return c.json({ error: "Site context is required" }, 400);
  }
  const id = c.req.param("id");
  const user = c.get("user");

  const [existing] = await db
    .select()
    .from(content)
    .where(and(eq(content.id, id), eq(content.siteId, siteId)));
  if (!existing) {
    return c.json({ error: "Content not found" }, 404);
  }

  const [updated] = await db
    .update(content)
    .set({ status: "archived", updatedAt: new Date() })
    .where(eq(content.id, id))
    .returning();

  await db.insert(auditLog).values({
    siteId: existing.siteId,
    actorType: "user",
    actorId: user.id,
    action: "content.archived",
    entityType: "content",
    entityId: id,
  });

  if (existing.status === "published") {
    purgeContentCache(c.get("site"), existing.slug, existing.type);
  }

  return c.json(updated);
});

// Unarchive (restore from trash)
contentRoutes.post("/:id/unarchive", requireRole("editor", "admin", "owner"), async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) {
    return c.json({ error: "Site context is required" }, 400);
  }
  const id = c.req.param("id");
  const user = c.get("user");

  const [existing] = await db
    .select()
    .from(content)
    .where(and(eq(content.id, id), eq(content.siteId, siteId)));
  if (!existing) {
    return c.json({ error: "Content not found" }, 404);
  }
  if (existing.status !== "archived") {
    return c.json({ error: "Content is not archived" }, 400);
  }

  // If another active page has claimed this slug while it was archived, pick a free one
  let restoredSlug = existing.slug;
  const [slugTaken] = await db
    .select({ id: content.id })
    .from(content)
    .where(and(eq(content.siteId, siteId), eq(content.slug, existing.slug), ne(content.id, id), ne(content.status, "archived")))
    .limit(1);
  if (slugTaken) {
    for (let i = 2; i <= 999; i++) {
      const candidate = `${existing.slug}-${i}`;
      const [taken] = await db
        .select({ id: content.id })
        .from(content)
        .where(and(eq(content.siteId, siteId), eq(content.slug, candidate), ne(content.status, "archived")))
        .limit(1);
      if (!taken) { restoredSlug = candidate; break; }
    }
  }

  const [updated] = await db
    .update(content)
    .set({ status: "draft", slug: restoredSlug, updatedAt: new Date() })
    .where(eq(content.id, id))
    .returning();

  await db.insert(auditLog).values({
    siteId: existing.siteId,
    actorType: "user",
    actorId: user.id,
    action: "content.unarchived",
    entityType: "content",
    entityId: id,
  });

  return c.json(updated);
});

// Get version history for a content item
contentRoutes.get("/:id/versions", async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) {
    return c.json({ error: "Site context is required" }, 400);
  }
  const id = c.req.param("id");

  const [parent] = await db
    .select({ id: content.id })
    .from(content)
    .where(and(eq(content.id, id), eq(content.siteId, siteId)));
  if (!parent) {
    return c.json({ error: "Content not found" }, 404);
  }

  const versions = await db
    .select()
    .from(contentVersions)
    .where(eq(contentVersions.contentId, id))
    .orderBy(desc(contentVersions.version));

  const authorIds = [...new Set(versions.map((v) => v.createdBy).filter((u): u is string => !!u))];
  const authorMap: Record<string, string> = {};
  if (authorIds.length > 0) {
    const authors = await db
      .select({ id: users.id, email: users.email, firstName: users.firstName, lastName: users.lastName })
      .from(users)
      .where(inArray(users.id, authorIds));
    for (const u of authors) {
      const name = [u.firstName, u.lastName].filter(Boolean).join(" ");
      authorMap[u.id] = name || u.email;
    }
  }

  const enriched = versions.map((v) => ({
    ...v,
    authorName: v.createdBy ? authorMap[v.createdBy] ?? null : null,
  }));

  return c.json({ versions: enriched });
});

// Restore a specific version
contentRoutes.post("/:id/versions/:version/restore", requireRole("editor", "admin", "owner"), async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) {
    return c.json({ error: "Site context is required" }, 400);
  }
  const id = c.req.param("id");
  const version = Number(c.req.param("version"));
  const user = c.get("user");

  const [parent] = await db
    .select({ id: content.id })
    .from(content)
    .where(and(eq(content.id, id), eq(content.siteId, siteId)));
  if (!parent) {
    return c.json({ error: "Content not found" }, 404);
  }

  const [snapshot] = await db
    .select()
    .from(contentVersions)
    .where(and(eq(contentVersions.contentId, id), eq(contentVersions.version, version)));

  if (!snapshot) {
    return c.json({ error: "Version not found" }, 404);
  }

  const snapshotBlocks = snapshot.blocksSnapshot as Array<{
    blockType: string;
    position: number;
    data: unknown;
  }>;

  const { updated, restoredBlocks } = await db.transaction(async (tx) => {
    const [upd] = await tx
      .update(content)
      .set({
        schemaData: snapshot.schemaData,
        updatedAt: new Date(),
      })
      .where(eq(content.id, id))
      .returning();

    await tx.delete(contentBlocks).where(eq(contentBlocks.contentId, id));
    if (snapshotBlocks?.length) {
      ensureFormIds(snapshotBlocks);
      sanitizeHtmlBlocks(snapshotBlocks);
      await tx.insert(contentBlocks).values(
        snapshotBlocks.map((block, i) => ({
          contentId: id,
          position: i,
          blockType: block.blockType,
          data: block.data || {},
        }))
      );
    }

    const [maxVersion] = await tx
      .select({ max: sql<number>`coalesce(max(${contentVersions.version}), 0)` })
      .from(contentVersions)
      .where(eq(contentVersions.contentId, id));

    await tx.insert(contentVersions).values({
      contentId: id,
      version: Number(maxVersion.max) + 1,
      schemaData: snapshot.schemaData,
      blocksSnapshot: snapshot.blocksSnapshot,
      createdBy: user.id,
    });

    await tx.insert(auditLog).values({
      siteId: upd.siteId,
      actorType: "user",
      actorId: user.id,
      action: "content.version_restored",
      entityType: "content",
      entityId: id,
      details: { restoredFromVersion: version },
    });

    const blks = await tx
      .select()
      .from(contentBlocks)
      .where(eq(contentBlocks.contentId, id))
      .orderBy(contentBlocks.position);

    return { updated: upd, restoredBlocks: blks };
  });

  await recompileSiteCss(siteId);

  if (updated.status === "published") {
    purgeContentCache(c.get("site"), updated.slug, updated.type);
  }

  return c.json({ ...updated, blocks: restoredBlocks });
});

// Attach media to content
contentRoutes.post("/:id/media", async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) {
    return c.json({ error: "Site context is required" }, 400);
  }
  const id = c.req.param("id");
  const body = await c.req.json();
  const { mediaId, context } = body;

  if (!mediaId) {
    return c.json({ error: "mediaId is required" }, 400);
  }

  const [parent] = await db
    .select({ id: content.id })
    .from(content)
    .where(and(eq(content.id, id), eq(content.siteId, siteId)));
  if (!parent) {
    return c.json({ error: "Content not found" }, 404);
  }

  // The media being attached must belong to this site too — otherwise a member
  // could reference another tenant's media id on their own page.
  const [mediaRow] = await db
    .select({ id: media.id })
    .from(media)
    .where(and(eq(media.id, mediaId), eq(media.siteId, siteId)));
  if (!mediaRow) {
    return c.json({ error: "Media not found" }, 404);
  }

  await db
    .insert(contentMedia)
    .values({ contentId: id, mediaId, context: context || null })
    .onConflictDoNothing();

  return c.json({ contentId: id, mediaId }, 201);
});

// Detach media from content
contentRoutes.delete("/:id/media/:mediaId", async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) {
    return c.json({ error: "Site context is required" }, 400);
  }
  const contentId = c.req.param("id");
  const mediaId = c.req.param("mediaId");

  const [parent] = await db
    .select({ id: content.id })
    .from(content)
    .where(and(eq(content.id, contentId), eq(content.siteId, siteId)));
  if (!parent) {
    return c.json({ error: "Content not found" }, 404);
  }

  await db
    .delete(contentMedia)
    .where(
      and(
        eq(contentMedia.contentId, contentId),
        eq(contentMedia.mediaId, mediaId)
      )
    );

  return c.json({ deleted: true });
});

// Generate a preview URL for a content item
contentRoutes.post("/:id/preview", async (c) => {
  const id = c.req.param("id");
  const siteId = c.get("site")?.siteId;
  if (!siteId) {
    return c.json({ error: "Site context is required" }, 400);
  }

  const [item] = await db.select().from(content).where(
    and(eq(content.id, id), eq(content.siteId, siteId))
  );
  if (!item) {
    return c.json({ error: "Content not found" }, 404);
  }

  const token = await signPreviewToken(id, siteId);

  const slug = item.slug;
  const prefix = item.type === "post" ? "/blog" : "";
  const previewPath = slug === "home" ? "/" : `${prefix}/${slug}`;

  return c.json({ token, previewUrl: `${previewPath}?preview=${token}` });
});
