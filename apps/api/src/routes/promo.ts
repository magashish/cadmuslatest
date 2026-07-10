import { Hono } from "hono";
import { eq, and, lte, isNull, or } from "drizzle-orm";
import { db, promotions, partners } from "@cadmus/db";

export const promoRoutes = new Hono();

function isPromoValid(promo: typeof promotions.$inferSelect): { valid: boolean; reason?: string } {
  if (!promo.isActive) return { valid: false, reason: "This promotion is no longer active." };
  if (promo.expiresAt && promo.expiresAt < new Date()) return { valid: false, reason: "This promotion has expired." };
  if (promo.maxRedemptions !== null && promo.redemptionCount >= promo.maxRedemptions) {
    return { valid: false, reason: "This promotion has reached its maximum number of uses." };
  }
  return { valid: true };
}

// ── GET /api/promo/info/:code — public promo details for signup page ─────────

promoRoutes.get("/info/:code", async (c) => {
  const code = c.req.param("code");
  const [promo] = await db.select().from(promotions).where(eq(promotions.code, code.toLowerCase()));
  if (!promo) return c.json({ valid: false, reason: "Promotion not found." }, 404);

  const { valid, reason } = isPromoValid(promo);
  return c.json({
    valid,
    reason,
    name: promo.name,
    type: promo.type,
    trialDays: promo.trialDays,
    planOverride: promo.planOverride,
  });
});

// ── GET /api/promo/partner-info/:code — agency disclosure for signup ─────────
// Powers the signup-page banner for ?client= links: "X will have admin access
// and manage billing." Only resolves ACTIVE AGENCY partners — plain referral
// codes return 404 so this can't be used to enumerate partner names.

promoRoutes.get("/partner-info/:code", async (c) => {
  const code = c.req.param("code").trim().toUpperCase();
  const [partner] = await db.select().from(partners).where(eq(partners.code, code));
  if (!partner || partner.status !== "active" || !partner.isAgency) {
    return c.json({ valid: false }, 404);
  }
  return c.json({ valid: true, name: partner.name });
});

// ── GET /api/promo/redirect/:slug — vanity URL redirect ──────────────────────
// Called by the CF worker for cadmus.digital/go/:slug requests.

promoRoutes.get("/redirect/:slug", async (c) => {
  const slug = c.req.param("slug").toLowerCase();
  const [promo] = await db.select().from(promotions).where(eq(promotions.slug, slug));

  const baseDomain = process.env.BASE_DOMAIN || "cadmus.digital";

  if (!promo) {
    return c.redirect(`https://${baseDomain}/admin/signup`, 302);
  }

  const { valid } = isPromoValid(promo);
  if (!valid) {
    return c.redirect(`https://${baseDomain}/admin/signup`, 302);
  }

  const signupUrl = new URL(`https://${baseDomain}/admin/signup`);
  signupUrl.searchParams.set("promo", promo.code);
  if (promo.planOverride) signupUrl.searchParams.set("plan", promo.planOverride);
  return c.redirect(signupUrl.toString(), 302);
});
