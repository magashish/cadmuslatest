import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { db, platformConfig, aiUsage, sites, siteMembers, users, auditLog } from "@cadmus/db";
import type { AuthUser } from "@cadmus/shared";

export const platformConfigRoutes = new Hono<{ Variables: { user: AuthUser } }>();

// ── GET /platform-config — list all config rows ──────────────────────────────

platformConfigRoutes.get("/platform-config", async (c) => {
  const rows = await db.select().from(platformConfig).orderBy(platformConfig.key);
  return c.json({ items: rows });
});

// ── PUT /platform-config/:key — update a config value ────────────────────────

platformConfigRoutes.put("/platform-config/:key", async (c) => {
  const key = c.req.param("key");
  const user = c.get("user");
  const body = await c.req.json<{ value: unknown }>();

  if (body.value === undefined) {
    return c.json({ error: "value is required" }, 400);
  }

  const [existing] = await db.select().from(platformConfig).where(eq(platformConfig.key, key));
  if (!existing) {
    return c.json({ error: "Config key not found" }, 404);
  }

  const [updated] = await db
    .update(platformConfig)
    .set({ value: body.value, updatedAt: new Date(), updatedBy: user.id })
    .where(eq(platformConfig.key, key))
    .returning();

  return c.json({ item: updated });
});

// ── GET /ai-usage — platform-wide AI usage grouped by site ───────────────────

platformConfigRoutes.get("/ai-usage", async (c) => {
  // Fetch all usage rows with site name
  const rows = await db
    .select({
      siteId: aiUsage.siteId,
      siteName: sites.name,
      subdomain: sites.subdomain,
      usageType: aiUsage.usageType,
      period: aiUsage.period,
      count: aiUsage.count,
    })
    .from(aiUsage)
    .innerJoin(sites, eq(aiUsage.siteId, sites.id))
    .orderBy(sites.name);

  // Aggregate per site
  const siteMap = new Map<
    string,
    { siteId: string; siteName: string; subdomain: string; chatMessages30d: number; imagesMonthly: number; pagesLifetime: number }
  >();

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const monthStr = now.toISOString().slice(0, 7);  // YYYY-MM

  // For chat_message: sum counts for last 30 days (periods within last 30 days)
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().slice(0, 10);

  for (const row of rows) {
    if (!siteMap.has(row.siteId)) {
      siteMap.set(row.siteId, {
        siteId: row.siteId,
        siteName: row.siteName,
        subdomain: row.subdomain,
        chatMessages30d: 0,
        imagesMonthly: 0,
        pagesLifetime: 0,
      });
    }
    const entry = siteMap.get(row.siteId)!;

    if (row.usageType === "chat_message" && row.period >= thirtyDaysAgoStr && row.period <= todayStr) {
      entry.chatMessages30d += row.count;
    } else if (row.usageType === "image_generation" && row.period === monthStr) {
      entry.imagesMonthly += row.count;
    } else if (row.usageType === "page_with_images") {
      entry.pagesLifetime += row.count;
    }
  }

  const items = Array.from(siteMap.values());

  // Platform totals
  const totals = {
    chatMessages30d: items.reduce((s, r) => s + r.chatMessages30d, 0),
    imagesMonthly: items.reduce((s, r) => s + r.imagesMonthly, 0),
    pagesLifetime: items.reduce((s, r) => s + r.pagesLifetime, 0),
  };

  return c.json({ items, totals });
});

// ── PUT /sites/:id/override — staff plan/status override ─────────────────────

// "comped" = internal / forever-free: unlimited features, no Stripe billing.
// Distinct from the free *tier* ("free"), which is limited. Applying it also
// flips billing to "free" (see below) so there's no Stripe involvement.
const VALID_PLANS = ["free", "monthly", "annual", "comped"];
const VALID_STATUSES = ["onboarding", "free", "active", "suspended", "archived"];

platformConfigRoutes.put("/sites/:id/override", async (c) => {
  const siteId = c.req.param("id");
  const user = c.get("user");
  const body = await c.req.json<{ plan?: string; status?: string }>();

  if (!body.plan && !body.status) {
    return c.json({ error: "At least one of plan or status is required" }, 400);
  }

  if (body.plan && !VALID_PLANS.includes(body.plan)) {
    return c.json({ error: `plan must be one of: ${VALID_PLANS.join(", ")}` }, 400);
  }

  if (body.status && !VALID_STATUSES.includes(body.status)) {
    return c.json({ error: `status must be one of: ${VALID_STATUSES.join(", ")}` }, 400);
  }

  const [site] = await db.select().from(sites).where(eq(sites.id, siteId));
  if (!site) return c.json({ error: "Site not found" }, 404);

  const previousPlan = site.plan;
  const previousStatus = site.status;

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.status) updates.status = body.status;
  // Plan is the single source of truth for billing mode, so a plan change also
  // sets billing — no separate "mark as free" step:
  //   comped → billing "free"  (internal/forever-free: no Stripe customer)
  //   any other plan → billing "standard"  (Stripe-capable; a staff-granted paid
  //     tier with no subscription still surfaces as a comped override in billing
  //     status). This makes the transition OFF comped automatic.
  if (body.plan) {
    updates.plan = body.plan;
    updates.billing = body.plan === "comped" ? "free" : "standard";
  }

  const [updated] = await db.update(sites).set(updates).where(eq(sites.id, siteId)).returning();

  await db.insert(auditLog).values({
    siteId,
    actorType: "user",
    actorId: user.id,
    action: "admin.override",
    entityType: "site",
    entityId: siteId,
    details: {
      plan: body.plan ?? null,
      status: body.status ?? null,
      previousPlan,
      previousStatus,
      ...(updates.billing && updates.billing !== site.billing
        ? { billing: updates.billing, previousBilling: site.billing }
        : {}),
    },
  });

  return c.json({ ok: true, site: updated });
});
