import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db, subscriptions, paymentMethods, sites, users, partners, partnerSites, auditLog } from "@cadmus/db";
import { requireRole } from "../middleware/auth.js";
import {
  createCheckoutSession,
  createSubscriptionCheckoutSession,
  createBillingPortalSession,
  cancelSubscription,
  reactivateSubscription,
  createCustomer,
  createSubscription,
  updateSubscriptionPlan,
  getBillingPlans,
  getPlanForPriceId,
  getPriceIdForPlan,
  findBasePlanItem,
  getStripe,
  type BillingPlan,
} from "../lib/stripe.js";
import { getActiveSiteAddons } from "../lib/addons.js";
import { siteMembers } from "@cadmus/db";
import type { AuthUser } from "@cadmus/shared";
import { logError } from "../lib/log.js";

export const billingRoutes = new Hono<{ Variables: { user: AuthUser } }>();

// Active PAID entitlements for the Account screen. `interval` follows the site's
// current plan; `priceCents` is the price at that interval (0 for comped sites,
// which pay nothing).
async function listPaidAddonsForBilling(
  siteId: string,
  plan: string | null,
  comped: boolean
): Promise<Array<{ slug: string; name: string; priceCents: number; interval: "month" | "year" }>> {
  const active = await getActiveSiteAddons(siteId);
  const interval: "month" | "year" = plan === "annual" ? "year" : "month";
  return active
    .filter((a) => !a.isFree)
    .map((a) => ({
      slug: a.slug,
      name: a.name,
      priceCents: comped
        ? 0
        : (interval === "year" ? a.priceAnnualCents : a.priceMonthlyCents) ?? 0,
      interval,
    }));
}

// ── GET /plans — list available billing plans ──────────────────────────────

billingRoutes.get("/plans", async (c) => {
  return c.json({ plans: getBillingPlans() });
});

// ── GET / — subscription status ─────────────────────────────────────────────

billingRoutes.get("/", async (c) => {
  const user = c.get("user");
  const siteId = user.siteId;

  const [site] = await db
    .select({ billing: sites.billing, plan: sites.plan })
    .from(sites)
    .where(eq(sites.id, siteId));
  const billing = site?.billing ?? "standard";
  const sitePlan = site?.plan ?? "free";

  // Free sites short-circuit: no Stripe state, nothing to manage.
  // The admin app keys off `billing === "free"` to swap UI accordingly.
  // Also treat sites on the free plan (new plan field) the same way.
  if (billing === "free" || sitePlan === "free") {
    // A comped site is billing-free but NOT a limited free-tier site — it has
    // every feature unlocked. Flag it so the Account screen shows the "all
    // features unlocked" state instead of the free-plan upgrade prompt.
    const comped = sitePlan === "comped";
    return c.json({
      billing: "free",
      ...(comped ? { comped: true, plan: "comped" } : {}),
      subscription: null,
      paymentMethod: null,
      hasPaymentMethod: false,
      billingUser: null,
      billingPartner: null,
      addons: await listPaidAddonsForBilling(siteId, sitePlan, comped),
    });
  }

  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.siteId, siteId));

  if (!sub) {
    // We're past the free short-circuit, so sitePlan is a paid plan with no
    // Stripe subscription — i.e. a staff/comped override. Surface it so the
    // admin shows the granted plan (not "Free") without exposing Stripe-portal
    // actions (there's no customer to manage).
    return c.json({
      billing,
      comped: true,
      plan: sitePlan,
      subscription: null,
      paymentMethod: null,
      hasPaymentMethod: false,
      // Staff/comped override: entitlements exist but no Stripe charge.
      addons: await listPaidAddonsForBilling(siteId, sitePlan, true),
    });
  }

  // Get payment method — check local cache first, then Stripe directly
  let [pm] = await db
    .select()
    .from(paymentMethods)
    .where(eq(paymentMethods.subscriptionId, sub.id));

  // If no local record, check Stripe directly (webhook may not have fired yet)
  if (!pm) {
    const stripe = getStripe();
    if (stripe) {
      try {
        const methods = await stripe.customers.listPaymentMethods(sub.stripeCustomerId, { limit: 1 });
        if (methods.data.length > 0) {
          const stripePm = methods.data[0];
          const card = stripePm.card;
          // Cache locally for future requests
          const [created] = await db.insert(paymentMethods).values({
            subscriptionId: sub.id,
            stripePaymentMethodId: stripePm.id,
            type: stripePm.type,
            last4: card?.last4 || null,
            brand: card?.brand || null,
            expiryMonth: card?.exp_month || null,
            expiryYear: card?.exp_year || null,
            isDefault: true,
          }).returning();
          pm = created;
        }
      } catch (err) {
        logError("[billing] Failed to fetch payment methods from Stripe", err);
      }
    }
  }

  // Resolve billing owner (user + optional partner link)
  let billingUser: { id: string; email: string; name: string } | null = null;
  let billingPartner: { id: string; code: string; name: string } | null = null;
  if (sub.billingUserId) {
    const [u] = await db
      .select({ id: users.id, email: users.email, firstName: users.firstName, lastName: users.lastName })
      .from(users)
      .where(eq(users.id, sub.billingUserId));
    if (u) {
      const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email;
      billingUser = { id: u.id, email: u.email, name };
      const [p] = await db.select().from(partners).where(eq(partners.userId, u.id));
      if (p) {
        billingPartner = { id: p.id, code: p.code, name: p.name };
      }
    }
  }

  return c.json({
    billing,
    subscription: {
      id: sub.id,
      status: sub.status,
      trialStartedAt: sub.trialStartedAt,
      trialEndsAt: sub.trialEndsAt,
      currentPeriodStart: sub.currentPeriodStart,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      billingUserId: sub.billingUserId,
      stripePriceId: sub.stripePriceId,
      plan: getPlanForPriceId(sub.stripePriceId),
    },
    billingUser,
    billingPartner,
    paymentMethod: pm
      ? { brand: pm.brand, last4: pm.last4, expiryMonth: pm.expiryMonth, expiryYear: pm.expiryYear }
      : null,
    hasPaymentMethod: !!pm,
    addons: await listPaidAddonsForBilling(siteId, getPlanForPriceId(sub.stripePriceId), false),
  });
});

// ── POST /upgrade — upgrade a free site to a paid plan ──────────────────────
// Creates a Stripe customer if none exists, attaches payment method, creates
// subscription immediately (no trial). On 3DS, returns clientSecret.

billingRoutes.post("/upgrade", requireRole("owner"), async (c) => {
  const user = c.get("user");
  const siteId = user.siteId;

  const body = await c.req.json<{ plan: BillingPlan; paymentMethodId: string }>();
  const { plan, paymentMethodId } = body;

  if (plan !== "monthly" && plan !== "annual") {
    return c.json({ error: "plan must be 'monthly' or 'annual'" }, 400);
  }
  if (!paymentMethodId) {
    return c.json({ error: "paymentMethodId is required" }, 400);
  }
  if (!getBillingPlans().some((p) => p.plan === plan)) {
    return c.json({ error: `Plan "${plan}" is not configured` }, 400);
  }

  const stripe = getStripe();
  if (!stripe) {
    return c.json({ error: "Billing is not configured" }, 503);
  }

  const [site] = await db.select().from(sites).where(eq(sites.id, siteId));
  if (!site) return c.json({ error: "Site not found" }, 404);

  // Get or create Stripe customer
  let [sub] = await db.select().from(subscriptions).where(eq(subscriptions.siteId, siteId));
  let customerId: string;
  let billingUserId: string;

  if (sub) {
    customerId = sub.stripeCustomerId;
    billingUserId = sub.billingUserId || user.id;
  } else {
    const [ownerMember] = await db
      .select({ userId: siteMembers.userId })
      .from(siteMembers)
      .where(and(eq(siteMembers.siteId, siteId), eq(siteMembers.role, "owner")));

    const ownerId = ownerMember?.userId || user.id;
    const [owner] = await db.select().from(users).where(eq(users.id, ownerId));
    if (!owner) return c.json({ error: "Owner not found" }, 404);

    const customer = await createCustomer({
      email: owner.email,
      name: site.name,
      metadata: { siteId, userId: owner.id },
    });
    customerId = customer.id;
    billingUserId = owner.id;
  }

  // Attach payment method to customer and set as default
  await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });
  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: paymentMethodId },
  });

  // Create subscription (immediate charge, no trial)
  const priceId = getPriceIdForPlan(plan);
  const stripeSub = await createSubscription(customerId, { priceId, paymentMethodId });

  // Read the base-plan line item (subscriptions may carry add-on items too).
  const baseItem = findBasePlanItem(stripeSub);
  const periodStart = baseItem?.current_period_start;
  const periodEnd = baseItem?.current_period_end;

  if (sub) {
    await db
      .update(subscriptions)
      .set({
        stripeSubscriptionId: stripeSub.id,
        stripePriceId: baseItem?.price.id || null,
        status: stripeSub.status,
        currentPeriodStart: periodStart ? new Date(periodStart * 1000) : new Date(),
        currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
        cancelAtPeriodEnd: false,
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.id, sub.id));
  } else {
    await db.insert(subscriptions).values({
      siteId,
      stripeCustomerId: customerId,
      stripeSubscriptionId: stripeSub.id,
      stripePriceId: baseItem?.price.id || null,
      status: stripeSub.status,
      currentPeriodStart: periodStart ? new Date(periodStart * 1000) : new Date(),
      currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
      billingUserId,
    });
  }

  // Update site plan and status if payment succeeded immediately
  if (stripeSub.status === "active") {
    await db
      .update(sites)
      .set({ plan, status: "active", planEndsAt: null, updatedAt: new Date() })
      .where(eq(sites.id, siteId));
  }

  await db.insert(auditLog).values({
    siteId,
    actorType: "user",
    actorId: user.id,
    action: "billing.upgraded",
    entityType: "site",
    entityId: siteId,
    details: { plan, priceId, subscriptionId: stripeSub.id },
  });

  // Return clientSecret if 3DS is required
  const latestInvoice = stripeSub.latest_invoice as { payment_intent?: { client_secret?: string } } | null;
  const clientSecret = latestInvoice?.payment_intent?.client_secret;

  if (clientSecret && stripeSub.status !== "active") {
    return c.json({ clientSecret });
  }

  return c.json({ ok: true });
});

// ── POST /checkout-session — create Stripe Checkout to add payment method ───

billingRoutes.post("/checkout-session", requireRole("owner", "admin"), async (c) => {
  const authUser = c.get("user");
  const siteId = authUser.siteId;

  const { returnUrl, successUrl: successUrlOverride, cancelUrl: cancelUrlOverride, plan } = await c.req.json<{ returnUrl?: string; successUrl?: string; cancelUrl?: string; plan?: string }>();
  const baseUrl = returnUrl || `https://${process.env.BASE_DOMAIN || "cadmus.digital"}/admin/account`;
  const successUrl = successUrlOverride || `${baseUrl}?billing=success`;
  const cancelUrl = cancelUrlOverride || `${baseUrl}?billing=canceled`;

  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.siteId, siteId));

  // Free plan users: create a subscription checkout session
  if (!sub) {
    const [site] = await db.select({ name: sites.name, plan: sites.plan }).from(sites).where(eq(sites.id, siteId));
    const [owner] = await db.select({ email: users.email }).from(users).where(eq(users.id, authUser.id));
    if (!site || !owner) return c.json({ error: "Site not found" }, 404);

    const billingPlan = (plan === "annual" ? "annual" : "monthly") as "monthly" | "annual";
    const priceId = getPriceIdForPlan(billingPlan);
    if (!priceId) return c.json({ error: "Billing not configured" }, 503);

    const session = await createSubscriptionCheckoutSession({
      email: owner.email,
      name: site.name,
      priceId,
      successUrl,
      cancelUrl,
      metadata: { siteId, plan: billingPlan },
    });
    return c.json({ url: session.url });
  }

  // Existing subscription: open setup session to add/update payment method
  const session = await createCheckoutSession({
    customerId: sub.stripeCustomerId,
    successUrl,
    cancelUrl,
  });

  return c.json({ url: session.url });
});

// ── POST /portal-session — open Stripe Billing Portal ───────────────────────

billingRoutes.post("/portal-session", requireRole("owner", "admin"), async (c) => {
  const user = c.get("user");
  const siteId = user.siteId;

  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.siteId, siteId));
  if (!sub) {
    return c.json({ error: "No subscription found" }, 404);
  }

  const { returnUrl } = await c.req.json();
  const baseUrl = returnUrl || `https://${process.env.BASE_DOMAIN || "cadmus.digital"}/admin/account`;

  const session = await createBillingPortalSession({
    customerId: sub.stripeCustomerId,
    returnUrl: baseUrl,
  });

  return c.json({ url: session.url });
});

// ── POST /change-plan — switch subscription to a different plan ────────────

billingRoutes.post("/change-plan", requireRole("owner", "admin"), async (c) => {
  const user = c.get("user");
  const siteId = user.siteId;
  const { plan } = await c.req.json<{ plan: BillingPlan }>();

  if (plan !== "monthly" && plan !== "annual") {
    return c.json({ error: "plan must be 'monthly' or 'annual'" }, 400);
  }
  if (!getBillingPlans().some((p) => p.plan === plan)) {
    return c.json({ error: `Plan "${plan}" is not configured` }, 400);
  }

  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.siteId, siteId));
  if (!sub || !sub.stripeSubscriptionId) {
    return c.json({ error: "No active subscription found" }, 404);
  }

  // Swap every active paid add-on line onto the target interval's price so the
  // whole subscription bills on one interval (one invoice) alongside the base
  // plan change.
  const activePaidAddons = (await getActiveSiteAddons(siteId)).filter(
    (a) => !a.isFree && a.stripeSubscriptionItemId
  );
  const addonPriceSwaps = activePaidAddons
    .map((a) => ({
      itemId: a.stripeSubscriptionItemId as string,
      priceId: (plan === "annual" ? a.stripePriceAnnualId : a.stripePriceMonthlyId) ?? "",
    }))
    .filter((s) => s.priceId);

  const updated = await updateSubscriptionPlan(sub.stripeSubscriptionId, plan, addonPriceSwaps);
  const newPriceId = findBasePlanItem(updated)?.price.id || null;

  await db
    .update(subscriptions)
    .set({ stripePriceId: newPriceId, updatedAt: new Date() })
    .where(eq(subscriptions.id, sub.id));

  await db.insert(auditLog).values({
    siteId,
    actorType: "user",
    actorId: user.id,
    action: "billing.plan_changed",
    entityType: "subscription",
    entityId: sub.id,
    details: { plan, priceId: newPriceId },
  });

  return c.json({ ok: true, plan, priceId: newPriceId });
});

// ── POST /cancel — cancel subscription at period end ────────────────────────

billingRoutes.post("/cancel", requireRole("owner"), async (c) => {
  const user = c.get("user");
  const siteId = user.siteId;

  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.siteId, siteId));
  if (!sub || !sub.stripeSubscriptionId) {
    return c.json({ error: "No active subscription found" }, 404);
  }

  const updatedStripeSub = await cancelSubscription(sub.stripeSubscriptionId, true);

  // current_period_end is on the subscription item (base plan)
  const periodEndUnix = findBasePlanItem(updatedStripeSub)?.current_period_end ?? null;
  const planEndsAt = periodEndUnix ? new Date(periodEndUnix * 1000) : sub.currentPeriodEnd;

  await db
    .update(subscriptions)
    .set({ cancelAtPeriodEnd: true, updatedAt: new Date() })
    .where(eq(subscriptions.id, sub.id));

  // Record planEndsAt on the site so feature gates can enforce it
  if (planEndsAt) {
    await db
      .update(sites)
      .set({ planEndsAt, updatedAt: new Date() })
      .where(eq(sites.id, siteId));
  }

  await db.insert(auditLog).values({
    siteId,
    actorType: "user",
    actorId: user.id,
    action: "billing.cancelled",
    entityType: "site",
    entityId: siteId,
    details: { planEndsAt, currentPeriodEnd: sub.currentPeriodEnd },
  });

  const dateStr = planEndsAt
    ? planEndsAt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
    : "the end of your billing period";

  return c.json({
    planEndsAt,
    message: `Your plan stays active until ${dateStr}. After that, your site moves to the free tier. Custom domains and extra team members will stop working at that time.`,
  });
});

// ── POST /reactivate — undo pending cancellation ────────────────────────────

billingRoutes.post("/reactivate", requireRole("owner"), async (c) => {
  const user = c.get("user");
  const siteId = user.siteId;

  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.siteId, siteId));
  if (!sub || !sub.stripeSubscriptionId) {
    return c.json({ error: "No subscription found" }, 404);
  }

  await reactivateSubscription(sub.stripeSubscriptionId);
  await db
    .update(subscriptions)
    .set({ cancelAtPeriodEnd: false, updatedAt: new Date() })
    .where(eq(subscriptions.id, sub.id));

  await db.insert(auditLog).values({
    siteId,
    actorType: "user",
    actorId: user.id,
    action: "billing.reactivated",
    entityType: "site",
    entityId: siteId,
  });

  return c.json({ ok: true });
});

// ── PUT /transfer — transfer billing responsibility ─────────────────────────
// Owner can transfer billing to another user or partner.

billingRoutes.put("/transfer", requireRole("owner"), async (c) => {
  const user = c.get("user");
  const siteId = user.siteId;
  const { targetUserId, partnerCode } = await c.req.json();

  if (!targetUserId && !partnerCode) {
    return c.json({ error: "targetUserId or partnerCode is required" }, 400);
  }

  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.siteId, siteId));
  if (!sub) {
    return c.json({ error: "No subscription found" }, 404);
  }

  const stripe = getStripe();
  if (!stripe) {
    return c.json({ error: "Billing not configured" }, 503);
  }

  let newCustomerId: string;
  let newBillingUserId: string;

  if (partnerCode) {
    // Transfer to a partner
    const [partner] = await db.select().from(partners).where(eq(partners.code, partnerCode));
    if (!partner || partner.status !== "active") {
      return c.json({ error: "Invalid partner code" }, 400);
    }

    if (!partner.stripeCustomerId) {
      const [partnerUser] = await db.select().from(users).where(eq(users.id, partner.userId));
      if (!partnerUser) return c.json({ error: "Partner user not found" }, 404);

      const customer = await createCustomer({
        email: partnerUser.email,
        name: partner.name,
        metadata: { partnerId: partner.id, userId: partner.userId },
      });
      await db.update(partners).set({ stripeCustomerId: customer.id }).where(eq(partners.id, partner.id));
      newCustomerId = customer.id;
    } else {
      newCustomerId = partner.stripeCustomerId;
    }
    newBillingUserId = partner.userId;

    // Ensure partner_sites link exists
    const [existing] = await db
      .select()
      .from(partnerSites)
      .where(and(eq(partnerSites.partnerId, partner.id), eq(partnerSites.siteId, siteId)));
    if (!existing) {
      await db.insert(partnerSites).values({ partnerId: partner.id, siteId });
    } else if (!existing.billingActive) {
      await db.update(partnerSites).set({ billingActive: true }).where(eq(partnerSites.id, existing.id));
    }
  } else {
    // Transfer to a specific user
    const [targetUser] = await db.select().from(users).where(eq(users.id, targetUserId));
    if (!targetUser) {
      return c.json({ error: "Target user not found" }, 404);
    }

    const customer = await createCustomer({
      email: targetUser.email,
      name: [targetUser.firstName, targetUser.lastName].filter(Boolean).join(" ") || targetUser.email,
      metadata: { siteId, userId: targetUser.id },
    });
    newCustomerId = customer.id;
    newBillingUserId = targetUser.id;
  }

  // Update the Stripe subscription's customer
  if (sub.stripeSubscriptionId) {
    await stripe.subscriptions.update(sub.stripeSubscriptionId, {
      customer: newCustomerId,
    } as any);
  }

  await db
    .update(subscriptions)
    .set({
      stripeCustomerId: newCustomerId,
      billingUserId: newBillingUserId,
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.id, sub.id));

  await db.insert(auditLog).values({
    siteId,
    actorType: "user",
    actorId: user.id,
    action: "billing.transferred",
    entityType: "subscription",
    entityId: sub.id,
    details: { newBillingUserId, partnerCode: partnerCode || undefined },
  });

  return c.json({ ok: true });
});
