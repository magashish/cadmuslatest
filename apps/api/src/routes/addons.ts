import { Hono } from "hono";
import { eq, and, asc } from "drizzle-orm";
import { db, addons, siteAddons, sites, subscriptions, auditLog } from "@cadmus/db";
import { requireRole } from "../middleware/auth.js";
import { isCompedSite } from "../lib/feature-gates.js";
import { getAddonRegistryEntry } from "../lib/addon-registry.js";
import { addAddonItemToSubscription, removeAddonItem } from "../lib/stripe.js";
import { ensureTurnstileProvisioned, deprovisionTurnstileForDomain } from "../lib/turnstile-provision.js";
import type { AuthUser } from "@cadmus/shared";
import { logError } from "../lib/log.js";

// Tenant-facing add-on marketplace routes. Auth + site membership are applied by
// the mount in app.ts; each route operates on the caller's CURRENT site
// (user.siteId, rebound by requireSiteMembership).
export const addonsRoutes = new Hono<{ Variables: { user: AuthUser } }>();

// Filter a stored config object to only the keys the registry allows for a slug.
function filterConfig(slug: string, config: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set(getAddonRegistryEntry(slug).allowedConfigKeys);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    if (allowed.has(k)) out[k] = v;
  }
  return out;
}

// An install counts as present (installed=true) when active OR suspended.
// "removed" rows are treated as not installed.
function isInstalledStatus(status: string | null | undefined): status is "active" | "suspended" {
  return status === "active" || status === "suspended";
}

// ── GET /api/addons — published catalog + this site's install state ──────────

addonsRoutes.get("/", async (c) => {
  const siteId = c.get("user").siteId;

  const catalog = await db
    .select()
    .from(addons)
    .where(eq(addons.status, "published"))
    .orderBy(asc(addons.sortOrder), asc(addons.name));

  const installs = await db
    .select({ addonId: siteAddons.addonId, status: siteAddons.status, config: siteAddons.config })
    .from(siteAddons)
    .where(eq(siteAddons.siteId, siteId));
  const installMap = new Map(installs.map((i) => [i.addonId, i]));

  const items = catalog.map((a) => {
    const install = installMap.get(a.id);
    const installed = isInstalledStatus(install?.status);
    return {
      id: a.id,
      slug: a.slug,
      name: a.name,
      tagline: a.tagline,
      description: a.description,
      category: a.category,
      isFree: a.isFree,
      priceMonthlyCents: a.priceMonthlyCents,
      priceAnnualCents: a.priceAnnualCents,
      installed,
      installStatus: installed ? (install!.status as "active" | "suspended") : null,
      ...(installed
        ? { config: filterConfig(a.slug, (install!.config as Record<string, unknown>) ?? {}) }
        : {}),
    };
  });

  return c.json({ items });
});

// ── POST /api/addons/:slug/install ──────────────────────────────────────────

addonsRoutes.post("/:slug/install", requireRole("admin", "owner"), async (c) => {
  const user = c.get("user");
  const siteId = user.siteId;
  const slug = c.req.param("slug");

  const [addon] = await db.select().from(addons).where(eq(addons.slug, slug));
  if (!addon) return c.json({ error: "Add-on not found" }, 404);

  const [existing] = await db
    .select()
    .from(siteAddons)
    .where(and(eq(siteAddons.siteId, siteId), eq(siteAddons.addonId, addon.id)));

  // Unpublished add-ons can only be (re)installed if this site already has a
  // row for them (e.g. it was archived after install).
  if (addon.status !== "published" && !existing) {
    return c.json({ error: "Add-on not found" }, 404);
  }

  // Idempotency: already active → return current state WITHOUT touching Stripe.
  // A double-click or client retry must not add a second subscription item
  // (double-billing) or clobber the stored item id.
  if (existing?.status === "active") {
    return c.json({
      slug: addon.slug,
      installed: true,
      installStatus: "active",
      config: filterConfig(addon.slug, (existing.config as Record<string, unknown>) ?? {}),
    });
  }

  const [site] = await db
    .select({ plan: sites.plan, billing: sites.billing, domain: sites.domain, domainStatus: sites.domainStatus })
    .from(sites)
    .where(eq(sites.id, siteId));
  if (!site) return c.json({ error: "Site not found" }, 404);

  // Free-tier sites may install FREE add-ons only.
  if (site.plan === "free" && !addon.isFree) {
    return c.json(
      { error: "Paid add-ons require a paid plan. Upgrade to install this add-on.", upgradeRequired: true },
      403
    );
  }

  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.siteId, siteId));

  // Determine whether this install touches Stripe. Comped sites and staff
  // overrides (a paid plan with NO live subscription) entitle with no charge.
  // Free add-ons never touch Stripe regardless of plan.
  const hasLiveSubscription = !!sub?.stripeSubscriptionId;
  const usesStripe = !addon.isFree && !isCompedSite(site) && hasLiveSubscription;

  let stripeSubscriptionItemId: string | null = null;
  if (usesStripe) {
    const priceId = site.plan === "annual" ? addon.stripePriceAnnualId : addon.stripePriceMonthlyId;
    if (!priceId) {
      return c.json({ error: "This add-on is missing a Stripe price for your plan interval" }, 503);
    }
    stripeSubscriptionItemId = await addAddonItemToSubscription(sub!.stripeSubscriptionId!, priceId);
  }

  // UPSERT on (siteId, addonId): a fresh install seeds config from the catalog
  // defaults; a reinstall (removed/suspended row) flips back to active and keeps
  // the site's existing config — config is intentionally NOT in the conflict set.
  await db
    .insert(siteAddons)
    .values({
      siteId,
      addonId: addon.id,
      status: "active",
      config: (addon.configDefaults as Record<string, unknown>) ?? {},
      stripeSubscriptionItemId,
      installedBy: user.id,
    })
    .onConflictDoUpdate({
      target: [siteAddons.siteId, siteAddons.addonId],
      set: {
        status: "active",
        stripeSubscriptionItemId,
        installedBy: user.id,
        updatedAt: new Date(),
      },
    });

  // Turnstile on a live custom domain: provision a widget slot now so the
  // add-on works immediately (the platform widget only covers *.cadmus.digital).
  // Best-effort — a provisioning failure must not fail the install; forms
  // fail open until the domain-activation hook or a reinstall retries.
  if (slug === "turnstile-spam-protection" && site.domain && site.domainStatus === "active") {
    try {
      await ensureTurnstileProvisioned(siteId, site.domain);
    } catch (err) {
      logError(`[turnstile-provision] install hook failed for site ${siteId}`, err);
    }
  }

  const [row] = await db
    .select()
    .from(siteAddons)
    .where(and(eq(siteAddons.siteId, siteId), eq(siteAddons.addonId, addon.id)));

  await db.insert(auditLog).values({
    siteId,
    actorType: "user",
    actorId: user.id,
    action: "addon.installed",
    entityType: "addon",
    entityId: addon.id,
    details: { slug, paid: !addon.isFree },
  });

  return c.json({
    slug: addon.slug,
    installed: true,
    installStatus: row.status,
    config: filterConfig(addon.slug, (row.config as Record<string, unknown>) ?? {}),
  });
});

// ── DELETE /api/addons/:slug — uninstall ────────────────────────────────────

addonsRoutes.delete("/:slug", requireRole("admin", "owner"), async (c) => {
  const user = c.get("user");
  const siteId = user.siteId;
  const slug = c.req.param("slug");

  const [addon] = await db.select().from(addons).where(eq(addons.slug, slug));
  if (!addon) return c.json({ error: "Add-on not found" }, 404);

  const [row] = await db
    .select()
    .from(siteAddons)
    .where(and(eq(siteAddons.siteId, siteId), eq(siteAddons.addonId, addon.id)));
  if (!row || row.status === "removed") {
    return c.json({ error: "Add-on is not installed" }, 404);
  }

  if (row.stripeSubscriptionItemId) {
    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.siteId, siteId));
    if (sub?.stripeSubscriptionId) {
      try {
        await removeAddonItem(sub.stripeSubscriptionId, row.stripeSubscriptionItemId);
      } catch (err) {
        // The Stripe item may already be gone (out-of-band removal / canceled
        // sub). Proceed to tear down our local entitlement regardless.
        logError(`[addons] Failed to remove Stripe item for ${slug}`, err);
      }
    }
  }

  await db
    .update(siteAddons)
    .set({ status: "removed", stripeSubscriptionItemId: null, updatedAt: new Date() })
    .where(eq(siteAddons.id, row.id));

  // Mirror of the install hook: give the pool widget slot back when Turnstile
  // is uninstalled. Best-effort — a reclamation failure must not fail the
  // uninstall; a reinstall provisions a fresh slot either way.
  if (slug === "turnstile-spam-protection") {
    try {
      await deprovisionTurnstileForDomain(siteId);
    } catch (err) {
      logError(`[turnstile-provision] uninstall hook failed for site ${siteId}`, err);
    }
  }

  await db.insert(auditLog).values({
    siteId,
    actorType: "user",
    actorId: user.id,
    action: "addon.uninstalled",
    entityType: "addon",
    entityId: addon.id,
    details: { slug },
  });

  return c.json({ ok: true });
});

// ── PUT /api/addons/:slug/config — update per-site config ────────────────────

addonsRoutes.put("/:slug/config", requireRole("admin", "owner"), async (c) => {
  const user = c.get("user");
  const siteId = user.siteId;
  const slug = c.req.param("slug");

  const [addon] = await db.select().from(addons).where(eq(addons.slug, slug));
  if (!addon) return c.json({ error: "Add-on not found" }, 404);

  const [row] = await db
    .select()
    .from(siteAddons)
    .where(and(eq(siteAddons.siteId, siteId), eq(siteAddons.addonId, addon.id)));
  if (!row || row.status === "removed") {
    return c.json({ error: "Add-on is not installed" }, 404);
  }

  const body = await c.req.json<Record<string, unknown>>();
  const filtered = filterConfig(slug, body); // drop keys the registry doesn't allow
  const merged = { ...((row.config as Record<string, unknown>) ?? {}), ...filtered };

  await db
    .update(siteAddons)
    .set({ config: merged, updatedAt: new Date() })
    .where(eq(siteAddons.id, row.id));

  await db.insert(auditLog).values({
    siteId,
    actorType: "user",
    actorId: user.id,
    action: "addon.config_updated",
    entityType: "addon",
    entityId: addon.id,
    // Log key NAMES only — never secret values (e.g. a Turnstile secretKey).
    details: { slug, keys: Object.keys(filtered) },
  });

  return c.json({
    slug,
    config: filterConfig(slug, merged),
  });
});
