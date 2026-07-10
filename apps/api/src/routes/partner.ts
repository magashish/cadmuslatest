import { Hono } from "hono";
import { eq, desc } from "drizzle-orm";
import { db, partners, partnerSites, referrals, sites } from "@cadmus/db";
import type { AuthUser } from "@cadmus/shared";

// Partner self-service portal (v1). Mounted with requireAuth +
// requireGlobalRole("partner") — every query is scoped to the partner row
// owned by the AUTHENTICATED user, never a client-supplied id.
export const partnerRoutes = new Hono<{ Variables: { user: AuthUser } }>();

partnerRoutes.get("/overview", async (c) => {
  const user = c.get("user");

  const [partner] = await db.select().from(partners).where(eq(partners.userId, user.id));
  if (!partner) return c.json({ error: "No partner profile for this account" }, 404);

  const [referralRows, linkedSiteRows] = await Promise.all([
    db
      .select({
        id: referrals.id,
        siteName: sites.name,
        status: referrals.status,
        createdAt: referrals.createdAt,
        qualifiedAt: referrals.qualifiedAt,
        rewardedAt: referrals.rewardedAt,
      })
      .from(referrals)
      .innerJoin(sites, eq(referrals.referredSiteId, sites.id))
      .where(eq(referrals.referrerUserId, user.id))
      .orderBy(desc(referrals.createdAt)),
    db
      .select({
        siteId: sites.id,
        siteName: sites.name,
        subdomain: sites.subdomain,
        siteStatus: sites.status,
        billingActive: partnerSites.billingActive,
        linkedAt: partnerSites.createdAt,
      })
      .from(partnerSites)
      .innerJoin(sites, eq(partnerSites.siteId, sites.id))
      .where(eq(partnerSites.partnerId, partner.id))
      .orderBy(desc(partnerSites.createdAt)),
  ]);

  return c.json({
    partner: {
      name: partner.name,
      code: partner.code,
      isAgency: partner.isAgency,
      commissionRate: partner.commissionRate,
      commissionsOnAddons: partner.commissionsOnAddons,
      status: partner.status,
    },
    referrals: referralRows,
    linkedSites: linkedSiteRows,
  });
});
