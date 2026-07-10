import { Hono } from "hono";
import { eq, and, ne, asc, count } from "drizzle-orm";
import { db, addons, siteAddons } from "@cadmus/db";
import { getStripe, createAddonProduct, createAddonPrices } from "../lib/stripe.js";
import type { AuthUser } from "@cadmus/shared";

// Staff-only add-on catalog CRUD. Mounted under /api/admin, whose middleware
// already enforces the cadmus_admin global role — no extra auth here.
//
// NOTE ON AUDIT LOGGING: auditLog.siteId is NOT NULL, and catalog mutations are
// platform-level (they belong to no single site). Per the Wave 1 spec's stated
// fallback, we therefore skip audit rows for catalog CRUD rather than inventing
// a site id. Per-site install/uninstall audit lives in the tenant addons route.
export const adminAddonsRoutes = new Hono<{ Variables: { user: AuthUser } }>();

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ── GET /addons — catalog with active-install counts ────────────────────────

adminAddonsRoutes.get("/addons", async (c) => {
  const rows = await db
    .select()
    .from(addons)
    .orderBy(asc(addons.sortOrder), asc(addons.name));

  const counts = await db
    .select({ addonId: siteAddons.addonId, c: count() })
    .from(siteAddons)
    .where(eq(siteAddons.status, "active"))
    .groupBy(siteAddons.addonId);
  const countMap = new Map(counts.map((r) => [r.addonId, Number(r.c)]));

  const items = rows.map((a) => ({ ...a, activeInstallCount: countMap.get(a.id) ?? 0 }));
  return c.json({ items });
});

// ── POST /addons — create a catalog entry ───────────────────────────────────

adminAddonsRoutes.post("/addons", async (c) => {
  const body = await c.req.json<{
    slug: string;
    name: string;
    tagline?: string;
    description?: string;
    category?: string;
    isFree: boolean;
    priceMonthlyCents?: number;
    priceAnnualCents?: number;
    sortOrder?: number;
    configDefaults?: Record<string, unknown>;
  }>();

  const slug = body.slug?.toLowerCase().trim();
  if (!slug || !SLUG_RE.test(slug)) {
    return c.json({ error: "slug is required and must be kebab-case (e.g. my-add-on)" }, 400);
  }
  if (!body.name?.trim()) {
    return c.json({ error: "name is required" }, 400);
  }

  let stripeIds: { productId: string; priceMonthlyId: string; priceAnnualId: string } | null = null;
  if (!body.isFree) {
    if (!body.priceMonthlyCents || !body.priceAnnualCents || body.priceMonthlyCents <= 0 || body.priceAnnualCents <= 0) {
      return c.json({ error: "Paid add-ons require priceMonthlyCents and priceAnnualCents greater than 0" }, 400);
    }
    if (!getStripe()) {
      return c.json({ error: "Stripe not configured — cannot create paid add-ons" }, 503);
    }
    stripeIds = await createAddonProduct({
      name: body.name.trim(),
      monthlyCents: body.priceMonthlyCents,
      annualCents: body.priceAnnualCents,
    });
  }

  const [item] = await db
    .insert(addons)
    .values({
      slug,
      name: body.name.trim(),
      tagline: body.tagline?.trim() || null,
      description: body.description?.trim() || null,
      category: body.category?.trim() || null,
      isFree: body.isFree,
      priceMonthlyCents: body.isFree ? null : body.priceMonthlyCents,
      priceAnnualCents: body.isFree ? null : body.priceAnnualCents,
      stripeProductId: stripeIds?.productId ?? null,
      stripePriceMonthlyId: stripeIds?.priceMonthlyId ?? null,
      stripePriceAnnualId: stripeIds?.priceAnnualId ?? null,
      sortOrder: body.sortOrder ?? 0,
      configDefaults: body.configDefaults ?? {},
    })
    .returning();

  return c.json({ item }, 201);
});

// ── PUT /addons/:id — sparse update ─────────────────────────────────────────

adminAddonsRoutes.put("/addons/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{
    name?: string;
    tagline?: string | null;
    description?: string | null;
    category?: string | null;
    isFree?: boolean;
    priceMonthlyCents?: number | null;
    priceAnnualCents?: number | null;
    status?: string;
    sortOrder?: number;
    configDefaults?: Record<string, unknown>;
  }>();

  const [existing] = await db.select().from(addons).where(eq(addons.id, id));
  if (!existing) return c.json({ error: "Not found" }, 404);

  if (body.status !== undefined && !["draft", "published", "archived"].includes(body.status)) {
    return c.json({ error: "status must be draft, published, or archived" }, 400);
  }

  // Resolve the effective free/paid state and prices after this update.
  const willBeFree = body.isFree ?? existing.isFree;
  const nextMonthly = body.priceMonthlyCents ?? existing.priceMonthlyCents;
  const nextAnnual = body.priceAnnualCents ?? existing.priceAnnualCents;

  // Block paid → free while any active paid install exists (those installs are
  // billed subscription line items — flipping the catalog to free would strand
  // them).
  if (!existing.isFree && willBeFree) {
    const [{ c: activePaid }] = await db
      .select({ c: count() })
      .from(siteAddons)
      .where(and(eq(siteAddons.addonId, id), eq(siteAddons.status, "active")));
    if (Number(activePaid) > 0) {
      return c.json({ error: "Cannot make a paid add-on free while it has active paid installs" }, 409);
    }
  }

  const stripeUpdates: {
    stripeProductId?: string;
    stripePriceMonthlyId?: string;
    stripePriceAnnualId?: string;
  } = {};

  if (!willBeFree) {
    // Becoming/remaining paid requires valid prices.
    if (!nextMonthly || !nextAnnual || nextMonthly <= 0 || nextAnnual <= 0) {
      return c.json({ error: "Paid add-ons require priceMonthlyCents and priceAnnualCents greater than 0" }, 400);
    }
    if (existing.isFree && willBeFree === false) {
      // free → paid: mint a fresh product + prices.
      if (!getStripe()) return c.json({ error: "Stripe not configured — cannot create paid add-ons" }, 503);
      const ids = await createAddonProduct({ name: (body.name ?? existing.name).trim(), monthlyCents: nextMonthly, annualCents: nextAnnual });
      stripeUpdates.stripeProductId = ids.productId;
      stripeUpdates.stripePriceMonthlyId = ids.priceMonthlyId;
      stripeUpdates.stripePriceAnnualId = ids.priceAnnualId;
    } else if (
      existing.stripeProductId &&
      ((body.priceMonthlyCents !== undefined && body.priceMonthlyCents !== existing.priceMonthlyCents) ||
        (body.priceAnnualCents !== undefined && body.priceAnnualCents !== existing.priceAnnualCents))
    ) {
      // Price change on an existing paid product: mint NEW Stripe prices (prices
      // are immutable). Existing installs keep their old subscription-item price
      // — they're grandfathered; only new installs pick up these.
      if (!getStripe()) return c.json({ error: "Stripe not configured — cannot update prices" }, 503);
      const ids = await createAddonPrices(existing.stripeProductId, nextMonthly, nextAnnual);
      stripeUpdates.stripePriceMonthlyId = ids.priceMonthlyId;
      stripeUpdates.stripePriceAnnualId = ids.priceAnnualId;
    }
  }

  const [item] = await db
    .update(addons)
    .set({
      ...(body.name !== undefined && { name: body.name.trim() }),
      ...(body.tagline !== undefined && { tagline: body.tagline ? body.tagline.trim() : null }),
      ...(body.description !== undefined && { description: body.description ? body.description.trim() : null }),
      ...(body.category !== undefined && { category: body.category ? body.category.trim() : null }),
      ...(body.isFree !== undefined && { isFree: body.isFree }),
      // When flipping to free, null out prices; otherwise apply provided prices.
      ...(willBeFree
        ? { priceMonthlyCents: null, priceAnnualCents: null }
        : {
            ...(body.priceMonthlyCents !== undefined && { priceMonthlyCents: body.priceMonthlyCents }),
            ...(body.priceAnnualCents !== undefined && { priceAnnualCents: body.priceAnnualCents }),
          }),
      ...stripeUpdates,
      ...(body.status !== undefined && { status: body.status }),
      ...(body.sortOrder !== undefined && { sortOrder: body.sortOrder }),
      ...(body.configDefaults !== undefined && { configDefaults: body.configDefaults }),
      updatedAt: new Date(),
    })
    .where(eq(addons.id, id))
    .returning();

  return c.json({ item });
});

// ── DELETE /addons/:id — hard delete, only when never installed ─────────────

adminAddonsRoutes.delete("/addons/:id", async (c) => {
  const id = c.req.param("id");

  // Any siteAddons row that isn't "removed" means the add-on is (or recently
  // was) in use — deleting would orphan billing/config history. Force archive.
  const [{ c: liveInstalls }] = await db
    .select({ c: count() })
    .from(siteAddons)
    .where(and(eq(siteAddons.addonId, id), ne(siteAddons.status, "removed")));
  if (Number(liveInstalls) > 0) {
    return c.json({ error: "Add-on has installs — archive it instead of deleting" }, 409);
  }

  const deleted = await db.delete(addons).where(eq(addons.id, id)).returning({ id: addons.id });
  if (deleted.length === 0) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});
