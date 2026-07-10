import { Hono } from "hono";
import { eq, and, sql } from "drizzle-orm";
import { db, collections, contentCollections, content, auditLog } from "@cadmus/db";
import type { SiteEnv } from "../middleware/tenant.js";
import type { AuthUser } from "@cadmus/shared";

export const collectionsRoutes = new Hono<SiteEnv & { Variables: { user: AuthUser } }>();

// List collections for a site
collectionsRoutes.get("/", async (c) => {
  const siteId = c.get("site")?.siteId;
  const type = c.req.query("type");

  if (!siteId) {
    return c.json({ error: "Site context is required" }, 400);
  }

  const conditions = [eq(collections.siteId, siteId)];
  if (type) conditions.push(eq(collections.type, type));

  const items = await db
    .select()
    .from(collections)
    .where(and(...conditions));

  return c.json({ items });
});

// Create collection
collectionsRoutes.post("/", async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) {
    return c.json({ error: "Site context is required" }, 400);
  }

  const user = c.get("user");
  const body = await c.req.json();
  const { type, name, slug, parentId } = body;

  if (!type || !name || !slug) {
    return c.json({ error: "type, name, and slug are required" }, 400);
  }

  const [dupe] = await db
    .select({ id: collections.id })
    .from(collections)
    .where(and(eq(collections.siteId, siteId), eq(collections.slug, slug)))
    .limit(1);
  if (dupe) {
    return c.json({ error: `A collection with slug "${slug}" already exists.` }, 409);
  }

  const [item] = await db
    .insert(collections)
    .values({ siteId, type, name, slug, parentId })
    .returning();

  await db.insert(auditLog).values({
    siteId,
    actorType: "user",
    actorId: user.id,
    action: "collection.created",
    entityType: "collection",
    entityId: item.id,
    details: { type, name, slug },
  });

  return c.json(item, 201);
});

// Update collection
collectionsRoutes.put("/:id", async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) {
    return c.json({ error: "Site context is required" }, 400);
  }
  const id = c.req.param("id");
  const user = c.get("user");
  const body = await c.req.json();
  const { name, slug, parentId } = body;

  const [existing] = await db
    .select()
    .from(collections)
    .where(and(eq(collections.id, id), eq(collections.siteId, siteId)));
  if (!existing) {
    return c.json({ error: "Collection not found" }, 404);
  }

  const updates: Record<string, unknown> = {};
  if (name !== undefined) updates.name = name;
  if (slug !== undefined) updates.slug = slug;
  if (parentId !== undefined) updates.parentId = parentId;

  const [updated] = await db
    .update(collections)
    .set(updates)
    .where(eq(collections.id, id))
    .returning();

  await db.insert(auditLog).values({
    siteId: existing.siteId,
    actorType: "user",
    actorId: user.id,
    action: "collection.updated",
    entityType: "collection",
    entityId: id,
    details: { changes: Object.keys(updates) },
  });

  return c.json(updated);
});

// Delete collection
collectionsRoutes.delete("/:id", async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) {
    return c.json({ error: "Site context is required" }, 400);
  }
  const id = c.req.param("id");
  const user = c.get("user");

  const [existing] = await db
    .select()
    .from(collections)
    .where(and(eq(collections.id, id), eq(collections.siteId, siteId)));
  if (!existing) {
    return c.json({ error: "Collection not found" }, 404);
  }

  await db.transaction(async (tx) => {
    await tx.delete(contentCollections).where(eq(contentCollections.collectionId, id));
    await tx.delete(collections).where(eq(collections.id, id));

    await tx.insert(auditLog).values({
      siteId: existing.siteId,
      actorType: "user",
      actorId: user.id,
      action: "collection.deleted",
      entityType: "collection",
      entityId: id,
      details: { name: existing.name },
    });
  });

  return c.json({ deleted: true });
});

// Get collections for a content item
collectionsRoutes.get("/by-content/:contentId", async (c) => {
  const siteId = c.get("site")?.siteId;
  const contentId = c.req.param("contentId");

  if (!siteId) {
    return c.json({ error: "Site context is required" }, 400);
  }

  const items = await db
    .select({
      id: collections.id,
      siteId: collections.siteId,
      type: collections.type,
      name: collections.name,
      slug: collections.slug,
      parentId: collections.parentId,
      createdAt: collections.createdAt,
    })
    .from(contentCollections)
    .innerJoin(collections, eq(contentCollections.collectionId, collections.id))
    .where(
      and(
        eq(contentCollections.contentId, contentId),
        eq(collections.siteId, siteId)
      )
    );

  return c.json({ items });
});

// Add content to a collection
collectionsRoutes.post("/:id/content", async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) {
    return c.json({ error: "Site context is required" }, 400);
  }
  const collectionId = c.req.param("id");
  const { contentId } = await c.req.json();

  if (!contentId) {
    return c.json({ error: "contentId is required" }, 400);
  }

  const [col] = await db
    .select({ id: collections.id })
    .from(collections)
    .where(and(eq(collections.id, collectionId), eq(collections.siteId, siteId)));
  if (!col) {
    return c.json({ error: "Collection not found" }, 404);
  }
  const [cnt] = await db
    .select({ id: content.id })
    .from(content)
    .where(and(eq(content.id, contentId), eq(content.siteId, siteId)));
  if (!cnt) {
    return c.json({ error: "Content not found" }, 404);
  }

  await db
    .insert(contentCollections)
    .values({ contentId, collectionId })
    .onConflictDoNothing();

  return c.json({ contentId, collectionId }, 201);
});

// Remove content from a collection
collectionsRoutes.delete("/:id/content/:contentId", async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) {
    return c.json({ error: "Site context is required" }, 400);
  }
  const collectionId = c.req.param("id");
  const contentId = c.req.param("contentId");

  const [col] = await db
    .select({ id: collections.id })
    .from(collections)
    .where(and(eq(collections.id, collectionId), eq(collections.siteId, siteId)));
  if (!col) {
    return c.json({ error: "Collection not found" }, 404);
  }

  await db
    .delete(contentCollections)
    .where(
      and(
        eq(contentCollections.collectionId, collectionId),
        eq(contentCollections.contentId, contentId)
      )
    );

  return c.json({ deleted: true });
});
