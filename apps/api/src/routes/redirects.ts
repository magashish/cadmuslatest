import { Hono } from "hono";
import { eq, and, asc } from "drizzle-orm";
import { db, redirects, auditLog } from "@cadmus/db";
import type { SiteEnv } from "../middleware/tenant.js";
import type { AuthUser } from "@cadmus/shared";

export const redirectsRoutes = new Hono<SiteEnv & { Variables: { user: AuthUser } }>();

redirectsRoutes.get("/", async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) return c.json({ error: "Site context is required" }, 400);

  const items = await db
    .select()
    .from(redirects)
    .where(eq(redirects.siteId, siteId))
    .orderBy(asc(redirects.createdAt));

  return c.json({ items });
});

redirectsRoutes.post("/", async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) return c.json({ error: "Site context is required" }, 400);

  const user = c.get("user");
  const body = await c.req.json<{
    fromPath: string;
    toUrl: string;
    statusCode?: number;
    enabled?: boolean;
  }>();

  const fromPath = (body.fromPath ?? "").trim();
  const toUrl = (body.toUrl ?? "").trim();
  if (!fromPath || !toUrl) {
    return c.json({ error: "fromPath and toUrl are required" }, 400);
  }
  if (!fromPath.startsWith("/")) {
    return c.json({ error: "fromPath must start with /" }, 400);
  }
  const statusCode = body.statusCode ?? 301;
  if (![301, 302, 307, 308].includes(statusCode)) {
    return c.json({ error: "statusCode must be 301, 302, 307, or 308" }, 400);
  }

  const [existing] = await db
    .select({ id: redirects.id })
    .from(redirects)
    .where(and(eq(redirects.siteId, siteId), eq(redirects.fromPath, fromPath)))
    .limit(1);
  if (existing) {
    return c.json({ error: `A redirect for "${fromPath}" already exists` }, 409);
  }

  const [item] = await db
    .insert(redirects)
    .values({ siteId, fromPath, toUrl, statusCode, enabled: body.enabled ?? true })
    .returning();

  await db.insert(auditLog).values({
    siteId,
    actorType: "user",
    actorId: user.id,
    action: "redirect.created",
    entityType: "redirect",
    entityId: item.id,
    details: { fromPath, toUrl, statusCode },
  });

  return c.json(item, 201);
});

// Bulk import from parsed CSV rows
redirectsRoutes.post("/import", async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) return c.json({ error: "Site context is required" }, 400);

  const user = c.get("user");
  const body = await c.req.json<{
    rows: Array<{ fromPath: string; toUrl: string; statusCode?: number }>;
  }>();

  if (!Array.isArray(body.rows) || body.rows.length === 0) {
    return c.json({ error: "rows must be a non-empty array" }, 400);
  }
  if (body.rows.length > 500) {
    return c.json({ error: "Maximum 500 rows per import" }, 400);
  }

  let created = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const row of body.rows) {
    const fromPath = (row.fromPath ?? "").trim();
    const toUrl = (row.toUrl ?? "").trim();
    const statusCode = row.statusCode ?? 301;

    if (!fromPath || !toUrl) { skipped++; continue; }
    if (!fromPath.startsWith("/")) { errors.push(`"${fromPath}" must start with /`); skipped++; continue; }
    if (![301, 302, 307, 308].includes(statusCode)) { errors.push(`Invalid status code ${statusCode} for ${fromPath}`); skipped++; continue; }

    try {
      await db
        .insert(redirects)
        .values({ siteId, fromPath, toUrl, statusCode, enabled: true })
        .onConflictDoNothing();
      created++;
    } catch {
      skipped++;
    }
  }

  await db.insert(auditLog).values({
    siteId,
    actorType: "user",
    actorId: user.id,
    action: "redirect.imported",
    entityType: "redirect",
    entityId: siteId,
    details: { created, skipped },
  });

  return c.json({ created, skipped, errors: errors.slice(0, 10) });
});

redirectsRoutes.put("/:id", async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) return c.json({ error: "Site context is required" }, 400);

  const user = c.get("user");
  const id = c.req.param("id");
  const body = await c.req.json<{
    toUrl?: string;
    statusCode?: number;
    enabled?: boolean;
  }>();

  const [existing] = await db
    .select()
    .from(redirects)
    .where(and(eq(redirects.id, id), eq(redirects.siteId, siteId)));
  if (!existing) return c.json({ error: "Redirect not found" }, 404);

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.toUrl !== undefined) updates.toUrl = body.toUrl.trim();
  if (body.statusCode !== undefined) {
    if (![301, 302, 307, 308].includes(body.statusCode)) {
      return c.json({ error: "statusCode must be 301, 302, 307, or 308" }, 400);
    }
    updates.statusCode = body.statusCode;
  }
  if (body.enabled !== undefined) updates.enabled = body.enabled;

  const [updated] = await db
    .update(redirects)
    .set(updates)
    .where(eq(redirects.id, id))
    .returning();

  await db.insert(auditLog).values({
    siteId,
    actorType: "user",
    actorId: user.id,
    action: "redirect.updated",
    entityType: "redirect",
    entityId: id,
    details: { changes: Object.keys(updates).filter((k) => k !== "updatedAt") },
  });

  return c.json(updated);
});

redirectsRoutes.delete("/:id", async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) return c.json({ error: "Site context is required" }, 400);

  const user = c.get("user");
  const id = c.req.param("id");

  const [existing] = await db
    .select()
    .from(redirects)
    .where(and(eq(redirects.id, id), eq(redirects.siteId, siteId)));
  if (!existing) return c.json({ error: "Redirect not found" }, 404);

  await db.delete(redirects).where(eq(redirects.id, id));

  await db.insert(auditLog).values({
    siteId,
    actorType: "user",
    actorId: user.id,
    action: "redirect.deleted",
    entityType: "redirect",
    entityId: id,
    details: { fromPath: existing.fromPath },
  });

  return c.json({ deleted: true });
});
