import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db, navigation, auditLog } from "@cadmus/db";
import type { SiteEnv } from "../middleware/tenant.js";
import { requireRole } from "../middleware/auth.js";
import type { AuthUser } from "@cadmus/shared";

export const navigationRoutes = new Hono<SiteEnv & { Variables: { user: AuthUser } }>();

// List navigation records for a site
navigationRoutes.get("/", async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) {
    return c.json({ error: "Site context is required" }, 400);
  }

  const location = c.req.query("location");
  const conditions = [eq(navigation.siteId, siteId)];
  if (location) conditions.push(eq(navigation.location, location));

  const items = await db
    .select()
    .from(navigation)
    .where(and(...conditions));

  return c.json({ items });
});

// Get single navigation record
navigationRoutes.get("/:id", async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) {
    return c.json({ error: "Site context is required" }, 400);
  }
  const id = c.req.param("id");

  const [item] = await db
    .select()
    .from(navigation)
    .where(and(eq(navigation.id, id), eq(navigation.siteId, siteId)));
  if (!item) {
    return c.json({ error: "Navigation not found" }, 404);
  }

  return c.json(item);
});

// Upsert navigation by location
navigationRoutes.put("/:location", requireRole("admin", "owner"), async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) {
    return c.json({ error: "Site context is required" }, 400);
  }

  const location = c.req.param("location");
  const user = c.get("user");
  const body = await c.req.json();
  const { items } = body;

  if (!items) {
    return c.json({ error: "items is required" }, 400);
  }

  const [existing] = await db
    .select()
    .from(navigation)
    .where(and(eq(navigation.siteId, siteId), eq(navigation.location, location)));

  let record;
  let statusCode: 200 | 201;

  if (existing) {
    const [updated] = await db
      .update(navigation)
      .set({ items, updatedAt: new Date() })
      .where(eq(navigation.id, existing.id))
      .returning();
    record = updated;
    statusCode = 200;
  } else {
    const [created] = await db
      .insert(navigation)
      .values({ siteId, location, items })
      .returning();
    record = created;
    statusCode = 201;
  }

  await db.insert(auditLog).values({
    siteId,
    actorType: "user",
    actorId: user.id,
    action: statusCode === 201 ? "navigation.created" : "navigation.updated",
    entityType: "navigation",
    entityId: record.id,
    details: { location },
  });

  return c.json(record, statusCode);
});

// Delete navigation record
navigationRoutes.delete("/:id", requireRole("admin", "owner"), async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) {
    return c.json({ error: "Site context is required" }, 400);
  }
  const id = c.req.param("id");
  const user = c.get("user");

  const [existing] = await db
    .select()
    .from(navigation)
    .where(and(eq(navigation.id, id), eq(navigation.siteId, siteId)));
  if (!existing) {
    return c.json({ error: "Navigation not found" }, 404);
  }

  await db.delete(navigation).where(eq(navigation.id, id));

  await db.insert(auditLog).values({
    siteId: existing.siteId,
    actorType: "user",
    actorId: user.id,
    action: "navigation.deleted",
    entityType: "navigation",
    entityId: id,
    details: { location: existing.location },
  });

  return c.json({ deleted: true });
});
