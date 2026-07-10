import { eq, and } from "drizzle-orm";
import { db, siteAddons, addons } from "@cadmus/db";
import { getAddonRegistryEntry, type AddonPublicConfigContext } from "./addon-registry.js";

export interface ActiveSiteAddon {
  addonId: string;
  slug: string;
  name: string;
  isFree: boolean;
  config: Record<string, unknown>;
  stripeSubscriptionItemId: string | null;
  priceMonthlyCents: number | null;
  priceAnnualCents: number | null;
  stripePriceMonthlyId: string | null;
  stripePriceAnnualId: string | null;
}

// All active entitlements for a site, joined to their catalog row. "Active"
// excludes suspended/removed installs. Note: a catalog row being archived does
// NOT drop it here — archiving only hides an add-on from marketplace browse; a
// site that already installed it keeps its entitlement.
export async function getActiveSiteAddons(siteId: string): Promise<ActiveSiteAddon[]> {
  const rows = await db
    .select({
      addonId: addons.id,
      slug: addons.slug,
      name: addons.name,
      isFree: addons.isFree,
      config: siteAddons.config,
      stripeSubscriptionItemId: siteAddons.stripeSubscriptionItemId,
      priceMonthlyCents: addons.priceMonthlyCents,
      priceAnnualCents: addons.priceAnnualCents,
      stripePriceMonthlyId: addons.stripePriceMonthlyId,
      stripePriceAnnualId: addons.stripePriceAnnualId,
    })
    .from(siteAddons)
    .innerJoin(addons, eq(siteAddons.addonId, addons.id))
    .where(and(eq(siteAddons.siteId, siteId), eq(siteAddons.status, "active")));

  return rows.map((r) => ({
    ...r,
    config: (r.config as Record<string, unknown>) ?? {},
  }));
}

// Whether a site currently has an active install of the given add-on slug.
export async function hasAddon(siteId: string, slug: string): Promise<boolean> {
  const [row] = await db
    .select({ id: siteAddons.id })
    .from(siteAddons)
    .innerJoin(addons, eq(siteAddons.addonId, addons.id))
    .where(
      and(
        eq(siteAddons.siteId, siteId),
        eq(addons.slug, slug),
        eq(siteAddons.status, "active")
      )
    );
  return !!row;
}

// Shape served to public site visitors: each active add-on's slug plus ONLY the
// public subset of its config (per the registry's publicConfig projection). This
// is the gate that keeps secrets (e.g. a Turnstile secretKey) out of the public
// payload.
export async function getPublicAddonsPayload(
  siteId: string,
  ctx?: AddonPublicConfigContext
): Promise<Array<{ slug: string; config: Record<string, unknown> }>> {
  const active = await getActiveSiteAddons(siteId);
  return active.map((a) => ({
    slug: a.slug,
    config: getAddonRegistryEntry(a.slug).publicConfig(a.config, ctx),
  }));
}
