import { Hono } from "hono";
import { eq, and, isNotNull } from "drizzle-orm";
import { db, subscriptions, paymentMethods, sites, referrals, auditLog, siteAddons } from "@cadmus/db";
import { constructWebhookEvent, getStripe, getPlanForPriceId, findBasePlanItem } from "../lib/stripe.js";
import { suspendSite, reinstateSite, nudgePastDue } from "../lib/site-lifecycle.js";
import type Stripe from "stripe";
import { logError } from "../lib/log.js";

export const webhookRoutes = new Hono();

// ── POST /stripe — Stripe webhook handler ───────────────────────────────────
// This endpoint is unauthenticated — verified via Stripe signature.
// Must receive raw body (not JSON-parsed).

webhookRoutes.post("/stripe", async (c) => {
  const signature = c.req.header("stripe-signature");
  if (!signature) {
    return c.json({ error: "Missing stripe-signature header" }, 400);
  }

  let event: Stripe.Event;
  try {
    const rawBody = await c.req.text();
    event = constructWebhookEvent(rawBody, signature);
  } catch (err) {
    logError("[webhook] Stripe signature verification failed", err);
    return c.json({ error: "Invalid signature" }, 400);
  }

  try {
    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        await syncSubscription(sub);
        break;
      }

      case "customer.subscription.deleted": {
        const stripeSub = event.data.object as Stripe.Subscription;
        const customerId = stripeSub.customer as string;

        // Find the local subscription record
        const [localSub] = await db
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.stripeCustomerId, customerId));

        if (localSub) {
          await db
            .update(subscriptions)
            .set({ status: "canceled", updatedAt: new Date() })
            .where(eq(subscriptions.id, localSub.id));

          // Downgrade the site to free tier
          await db
            .update(sites)
            .set({ plan: "free", status: "active", planEndsAt: null, updatedAt: new Date() })
            .where(eq(sites.id, localSub.siteId));

          // The subscription is gone, so every paid add-on line item went with
          // it — suspend those installs. Free add-ons (no subscription item)
          // are untouched.
          await db
            .update(siteAddons)
            .set({ status: "suspended", updatedAt: new Date() })
            .where(
              and(
                eq(siteAddons.siteId, localSub.siteId),
                isNotNull(siteAddons.stripeSubscriptionItemId)
              )
            );

          await db.insert(auditLog).values({
            siteId: localSub.siteId,
            actorType: "system",
            action: "billing.downgraded_to_free",
            entityType: "site",
            entityId: localSub.siteId,
            details: { reason: "subscription_deleted", stripeSubscriptionId: stripeSub.id },
          });

          console.log(`[billing] Site ${localSub.siteId} downgraded to free (subscription deleted)`);
        }
        break;
      }

      case "invoice.payment_succeeded": {
        const invoice = event.data.object as Stripe.Invoice;
        const succSubId = invoice.parent?.subscription_details?.subscription;
        if (succSubId) {
          const subId = typeof succSubId === "string" ? succSubId : succSubId.id;

          const amountPaid = invoice.amount_paid ?? 0;
          if (amountPaid > 0) {
            const [localSub] = await db
              .select()
              .from(subscriptions)
              .where(eq(subscriptions.stripeSubscriptionId, subId));

            if (localSub) {
              // Determine plan from priceId
              const plan = getPlanForPriceId(localSub.stripePriceId) ?? "monthly";

              await db
                .update(subscriptions)
                .set({ status: "active", hasEverPaid: true, updatedAt: new Date() })
                .where(eq(subscriptions.id, localSub.id));

              await db
                .update(sites)
                .set({ plan, status: "active", planEndsAt: null, updatedAt: new Date() })
                .where(eq(sites.id, localSub.siteId));

              // Qualify any pending referral on first real payment
              await db
                .update(referrals)
                .set({ status: "qualified", qualifiedAt: new Date() })
                .where(
                  and(
                    eq(referrals.referredSiteId, localSub.siteId),
                    eq(referrals.status, "pending")
                  )
                );

              // Auto-restore if the site was billing-suspended
              await reinstateSite({
                siteId: localSub.siteId,
                actor: { type: "system" },
                emailKind: "billing-reinstate",
                onlyIfSource: "billing",
              });
            }
          }
        }
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const failSubId = invoice.parent?.subscription_details?.subscription;
        if (failSubId) {
          const subId = typeof failSubId === "string" ? failSubId : failSubId.id;
          await db
            .update(subscriptions)
            .set({ status: "past_due", updatedAt: new Date() })
            .where(eq(subscriptions.stripeSubscriptionId, subId));

          // Update site status to suspended for payment failures
          const [localSub] = await db
            .select({ siteId: subscriptions.siteId, hasEverPaid: subscriptions.hasEverPaid })
            .from(subscriptions)
            .where(eq(subscriptions.stripeSubscriptionId, subId));

          if (localSub) {
            await db
              .update(sites)
              .set({ status: "suspended", updatedAt: new Date() })
              .where(eq(sites.id, localSub.siteId));

            if (localSub.hasEverPaid) {
              await nudgePastDue({ siteId: localSub.siteId });
            }
          }
        }
        break;
      }

      case "payment_method.attached": {
        const pm = event.data.object as Stripe.PaymentMethod;
        await syncPaymentMethod(pm);
        break;
      }

      case "payment_method.detached": {
        const pm = event.data.object as Stripe.PaymentMethod;
        await db
          .delete(paymentMethods)
          .where(eq(paymentMethods.stripePaymentMethodId, pm.id));
        break;
      }

      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;

        if (session.mode === "subscription" && session.subscription && session.metadata?.siteId) {
          // Free → paid upgrade via Stripe Checkout
          const stripe = getStripe();
          if (stripe) {
            const siteId = session.metadata.siteId;
            const stripeSub = await stripe.subscriptions.retrieve(session.subscription as string);
            const customerId = session.customer as string;
            const baseItem = findBasePlanItem(stripeSub);
            const priceId = baseItem?.price.id ?? null;
            // Derive the plan from the price actually purchased, not from
            // client-supplied checkout metadata. Metadata is only a fallback.
            const billingPlan =
              getPlanForPriceId(priceId) ??
              ((session.metadata.plan as "monthly" | "annual" | undefined) ?? "monthly");

            // Upsert the subscription record — syncSubscription bails if none exists
            const [existing] = await db.select().from(subscriptions).where(eq(subscriptions.siteId, siteId));
            if (existing) {
              await db.update(subscriptions).set({
                stripeSubscriptionId: stripeSub.id,
                stripeCustomerId: customerId,
                stripePriceId: priceId,
                status: stripeSub.status,
                updatedAt: new Date(),
              }).where(eq(subscriptions.id, existing.id));
            } else {
              await db.insert(subscriptions).values({
                siteId,
                stripeCustomerId: customerId,
                stripeSubscriptionId: stripeSub.id,
                stripePriceId: priceId,
                billingUserId: null,
                status: stripeSub.status,
                currentPeriodStart: baseItem
                  ? new Date(baseItem.current_period_start * 1000)
                  : new Date(),
                currentPeriodEnd: baseItem
                  ? new Date(baseItem.current_period_end * 1000)
                  : null,
                cancelAtPeriodEnd: false,
                trialEndsAt: null,
                hasEverPaid: stripeSub.status === "active",
              });
            }

            // Update site plan and status
            await db.update(sites)
              .set({ plan: billingPlan, status: "active", planEndsAt: null, updatedAt: new Date() })
              .where(eq(sites.id, siteId));

            console.log(`[webhook] checkout.session.completed: upgraded site ${siteId} to ${billingPlan}`);
          }
        } else if (session.mode === "setup" && session.setup_intent && session.customer) {
          // Setup mode: update default payment method on customer
          const stripe = getStripe();
          if (stripe) {
            const setupIntent = await stripe.setupIntents.retrieve(session.setup_intent as string);
            if (setupIntent.payment_method) {
              await stripe.customers.update(session.customer as string, {
                invoice_settings: {
                  default_payment_method: setupIntent.payment_method as string,
                },
              });
            }
          }
        }
        break;
      }

      default:
        // Unhandled event type — log but don't error
        console.log(`[webhook] Unhandled event type: ${event.type}`);
    }
  } catch (err) {
    logError(`[webhook] Error processing ${event.type}`, err);
    return c.json({ error: "Webhook processing failed" }, 500);
  }

  return c.json({ received: true });
});

// ── Helpers ─────────────────────────────────────────────────────────────────

async function syncSubscription(stripeSub: Stripe.Subscription) {
  const customerId = stripeSub.customer as string;
  const newStatus = stripeSub.status as string;

  const [existing] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.stripeCustomerId, customerId));

  if (!existing) return;

  // Derive price/period from the BASE plan item — subscriptions can now carry
  // add-on line items alongside the plan.
  const baseItem = findBasePlanItem(stripeSub);
  const updates = {
    stripeSubscriptionId: stripeSub.id,
    stripePriceId: baseItem?.price.id || null,
    status: newStatus,
    currentPeriodStart: baseItem
      ? new Date(baseItem.current_period_start * 1000)
      : new Date(),
    currentPeriodEnd: baseItem
      ? new Date(baseItem.current_period_end * 1000)
      : null,
    cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
    updatedAt: new Date(),
  };

  await db.update(subscriptions).set(updates).where(eq(subscriptions.id, existing.id));

  // ── Add-on reconciliation ─────────────────────────────────────────────
  // Recover from out-of-band changes (Stripe dashboard/portal): compare the
  // subscription's live line items against our siteAddons rows. A row whose
  // subscription-item id is no longer present → suspend; one that IS present →
  // ensure active.
  const liveItemIds = new Set(stripeSub.items.data.map((it) => it.id));
  const trackedAddons = await db
    .select({ id: siteAddons.id, itemId: siteAddons.stripeSubscriptionItemId, status: siteAddons.status })
    .from(siteAddons)
    .where(
      and(eq(siteAddons.siteId, existing.siteId), isNotNull(siteAddons.stripeSubscriptionItemId))
    );
  for (const addon of trackedAddons) {
    const present = addon.itemId ? liveItemIds.has(addon.itemId) : false;
    const desired = present ? "active" : "suspended";
    if (addon.status !== desired && addon.status !== "removed") {
      await db
        .update(siteAddons)
        .set({ status: desired, updatedAt: new Date() })
        .where(eq(siteAddons.id, addon.id));
    }
  }

  // ── Drive site lifecycle off status transitions ───────────────────────
  const prevStatus = existing.status;
  if (prevStatus === newStatus) return;

  // Retries exhausted → suspend
  if (newStatus === "unpaid" && existing.hasEverPaid) {
    await suspendSite({
      siteId: existing.siteId,
      source: "billing",
      reason: "Payment method failed after multiple attempts",
      actor: { type: "system" },
      emailKind: "payment-failed",
    });
    return;
  }

  if (newStatus === "incomplete_expired") {
    await suspendSite({
      siteId: existing.siteId,
      source: "billing",
      reason: "Payment incomplete",
      actor: { type: "system" },
      emailKind: "payment-failed",
    });
    return;
  }

  if (newStatus === "active") {
    const plan = getPlanForPriceId(updates.stripePriceId) ?? "monthly";
    await db
      .update(sites)
      .set({ plan, status: "active", planEndsAt: null, updatedAt: new Date() })
      .where(eq(sites.id, existing.siteId));

    await reinstateSite({
      siteId: existing.siteId,
      actor: { type: "system" },
      emailKind: "billing-reinstate",
      onlyIfSource: "billing",
    });
  }
}

async function syncPaymentMethod(pm: Stripe.PaymentMethod) {
  if (!pm.customer) return;

  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.stripeCustomerId, pm.customer as string));

  if (!sub) return;

  const card = pm.card;
  const values = {
    subscriptionId: sub.id,
    stripePaymentMethodId: pm.id,
    type: pm.type,
    last4: card?.last4 || null,
    brand: card?.brand || null,
    expiryMonth: card?.exp_month || null,
    expiryYear: card?.exp_year || null,
    isDefault: true,
  };

  // Upsert — replace any existing payment method for this subscription
  const [existing] = await db
    .select()
    .from(paymentMethods)
    .where(eq(paymentMethods.subscriptionId, sub.id));

  if (existing) {
    await db.update(paymentMethods).set(values).where(eq(paymentMethods.id, existing.id));
  } else {
    await db.insert(paymentMethods).values(values);
  }
}
