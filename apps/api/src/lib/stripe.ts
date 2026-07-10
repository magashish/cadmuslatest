import Stripe from "stripe";

let stripe: Stripe | null = null;

export function initStripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.log("[stripe] STRIPE_SECRET_KEY not set — billing disabled");
    return null;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stripe = new Stripe(key, { apiVersion: "2026-03-25.dahlia" as any });
  console.log("[stripe] Stripe initialized");
  return stripe;
}

export function getStripe(): Stripe | null {
  return stripe;
}

// ── Billing plans ─────────────────────────────────────────────────────────

export type BillingPlan = "monthly" | "annual";

export interface BillingPlanDetails {
  plan: BillingPlan;
  priceId: string;
  amountUsd: number;
  interval: "month" | "year";
  label: string;
}

const PLAN_CATALOG: Array<Omit<BillingPlanDetails, "priceId"> & { envVar: string }> = [
  { plan: "monthly", envVar: "STRIPE_PRICE_MONTHLY", amountUsd: 39, interval: "month", label: "Monthly" },
  { plan: "annual", envVar: "STRIPE_PRICE_ANNUAL", amountUsd: 390, interval: "year", label: "Annual" },
];

export function getBillingPlans(): BillingPlanDetails[] {
  const plans: BillingPlanDetails[] = [];
  for (const p of PLAN_CATALOG) {
    const priceId = process.env[p.envVar];
    if (!priceId) continue;
    plans.push({
      plan: p.plan,
      priceId,
      amountUsd: p.amountUsd,
      interval: p.interval,
      label: p.label,
    });
  }
  return plans;
}

export function getPriceIdForPlan(plan: BillingPlan): string {
  const found = getBillingPlans().find((p) => p.plan === plan);
  if (!found) throw new Error(`No Stripe price configured for plan "${plan}"`);
  return found.priceId;
}

export function getPlanForPriceId(priceId: string | null | undefined): BillingPlan | null {
  if (!priceId) return null;
  const found = getBillingPlans().find((p) => p.priceId === priceId);
  return found?.plan ?? null;
}

// ── Customer ──────────────────────────────────────────────────────────────

export async function createCustomer(opts: {
  email: string;
  name: string;
  metadata?: Record<string, string>;
}): Promise<Stripe.Customer> {
  if (!stripe) throw new Error("Stripe not initialized");
  return stripe.customers.create({
    email: opts.email,
    name: opts.name,
    metadata: opts.metadata || {},
  });
}

// ── Subscription (no trial) ─────────────────────────────────────────────

export async function createSubscription(
  customerId: string,
  opts: { priceId?: string; plan?: BillingPlan; paymentMethodId?: string }
): Promise<Stripe.Subscription> {
  if (!stripe) throw new Error("Stripe not initialized");
  const priceId = opts.priceId || getPriceIdForPlan(opts.plan ?? "monthly");

  return stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: priceId }],
    currency: "usd",
    ...(opts.paymentMethodId
      ? { default_payment_method: opts.paymentMethodId }
      : {}),
    payment_behavior: "default_incomplete",
    expand: ["latest_invoice.payment_intent"],
  });
}

// ── Checkout Session (for adding payment method) ─────────────────────────

export async function createCheckoutSession(opts: {
  customerId: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<Stripe.Checkout.Session> {
  if (!stripe) throw new Error("Stripe not initialized");
  return stripe.checkout.sessions.create({
    customer: opts.customerId,
    mode: "setup",
    currency: "usd",
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
  });
}

export async function createSubscriptionCheckoutSession(opts: {
  email: string;
  name: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  metadata?: Record<string, string>;
}): Promise<Stripe.Checkout.Session> {
  if (!stripe) throw new Error("Stripe not initialized");
  return stripe.checkout.sessions.create({
    customer_email: opts.email,
    mode: "subscription",
    line_items: [{ price: opts.priceId, quantity: 1 }],
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    metadata: opts.metadata,
  });
}

// ── Billing Portal ───────────────────────────────────────────────────────

export async function createBillingPortalSession(opts: {
  customerId: string;
  returnUrl: string;
}): Promise<Stripe.BillingPortal.Session> {
  if (!stripe) throw new Error("Stripe not initialized");
  return stripe.billingPortal.sessions.create({
    customer: opts.customerId,
    return_url: opts.returnUrl,
  });
}

// ── Cancel / Reactivate ─────────────────────────────────────────────────

export async function cancelSubscription(
  subscriptionId: string,
  atPeriodEnd = true
): Promise<Stripe.Subscription> {
  if (!stripe) throw new Error("Stripe not initialized");
  if (atPeriodEnd) {
    return stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true,
    });
  }
  return stripe.subscriptions.cancel(subscriptionId);
}

export async function reactivateSubscription(
  subscriptionId: string
): Promise<Stripe.Subscription> {
  if (!stripe) throw new Error("Stripe not initialized");
  return stripe.subscriptions.update(subscriptionId, {
    cancel_at_period_end: false,
  });
}

// Identify the subscription line item that carries the base plan. Subscriptions
// can now hold add-on line items alongside the base plan, so we can no longer
// assume `items.data[0]` is the plan. Match against the known base-plan price
// ids; fall back to the first item defensively if nothing matches (e.g. a
// mispriced or legacy subscription).
export function findBasePlanItem(sub: Stripe.Subscription): Stripe.SubscriptionItem | undefined {
  const basePriceIds = new Set(getBillingPlans().map((p) => p.priceId));
  return sub.items.data.find((it) => basePriceIds.has(it.price.id)) ?? sub.items.data[0];
}

// Swap a subscription onto a different base plan (and, when add-ons are present,
// swap each add-on line onto the matching-interval price so the whole
// subscription bills on one interval). Stripe auto-prorates and item IDs must be
// reused, so we resolve the base item first and pass through the caller's
// add-on swaps.
export async function updateSubscriptionPlan(
  subscriptionId: string,
  plan: BillingPlan,
  addonPriceSwaps: Array<{ itemId: string; priceId: string }> = []
): Promise<Stripe.Subscription> {
  if (!stripe) throw new Error("Stripe not initialized");
  const priceId = getPriceIdForPlan(plan);
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  const baseItem = findBasePlanItem(sub);
  if (!baseItem) throw new Error("Subscription has no items to update");
  return stripe.subscriptions.update(subscriptionId, {
    items: [
      { id: baseItem.id, price: priceId },
      ...addonPriceSwaps.map((s) => ({ id: s.itemId, price: s.priceId })),
    ],
    proration_behavior: "create_prorations",
  });
}

// ── Add-on products / prices ─────────────────────────────────────────────

export interface AddonStripeIds {
  productId: string;
  priceMonthlyId: string;
  priceAnnualId: string;
}

// Create a fresh Stripe product plus its monthly + annual recurring prices for a
// paid add-on. Used when staff first create a paid add-on in the catalog.
export async function createAddonProduct(opts: {
  name: string;
  monthlyCents: number;
  annualCents: number;
}): Promise<AddonStripeIds> {
  if (!stripe) throw new Error("Stripe not initialized");
  const product = await stripe.products.create({ name: opts.name });
  const { priceMonthlyId, priceAnnualId } = await createAddonPrices(
    product.id,
    opts.monthlyCents,
    opts.annualCents
  );
  return { productId: product.id, priceMonthlyId, priceAnnualId };
}

// Create a new monthly + annual price pair for an EXISTING add-on product. Used
// when staff edit an add-on's prices — Stripe prices are immutable, so we mint
// new ones. Existing installs keep their old subscription-item price (they're
// grandfathered); only new installs pick up these prices.
export async function createAddonPrices(
  productId: string,
  monthlyCents: number,
  annualCents: number
): Promise<{ priceMonthlyId: string; priceAnnualId: string }> {
  if (!stripe) throw new Error("Stripe not initialized");
  const monthly = await stripe.prices.create({
    product: productId,
    currency: "usd",
    unit_amount: monthlyCents,
    recurring: { interval: "month" },
  });
  const annual = await stripe.prices.create({
    product: productId,
    currency: "usd",
    unit_amount: annualCents,
    recurring: { interval: "year" },
  });
  return { priceMonthlyId: monthly.id, priceAnnualId: annual.id };
}

// Add a paid add-on as a new line item on the site's existing subscription and
// return the created subscription-item id.
//
// proration_behavior is "always_invoice" (NOT the usual "create_prorations")
// on purpose: it invoices AND charges the prorated remainder of the current
// period immediately. With plain create_prorations the proration would sit as an
// unbilled draft until the next renewal — for an annual site that's up to a year
// away, so a user could add a paid add-on, use it for months, then remove it
// before renewal for net-zero cost. Invoicing now closes that exploit.
export async function addAddonItemToSubscription(
  subscriptionId: string,
  priceId: string
): Promise<string> {
  if (!stripe) throw new Error("Stripe not initialized");
  await stripe.subscriptions.update(subscriptionId, {
    items: [{ price: priceId }],
    proration_behavior: "always_invoice",
  });
  // Re-retrieve to find the item id Stripe assigned to the new line.
  const updated = await stripe.subscriptions.retrieve(subscriptionId);
  const item = updated.items.data.find((it) => it.price.id === priceId);
  if (!item) throw new Error("Failed to locate newly added add-on subscription item");
  return item.id;
}

// Remove a paid add-on line item from the subscription.
//
// Asymmetry with add (above): removal uses "create_prorations", not
// always_invoice. The customer already paid for the current period; a prorated
// credit lands on their Stripe customer balance and offsets their next invoice.
// That's fair (they keep what they paid for, no cash refunds) and avoids issuing
// negative invoices / refunds on teardown.
export async function removeAddonItem(
  subscriptionId: string,
  itemId: string
): Promise<Stripe.Subscription> {
  if (!stripe) throw new Error("Stripe not initialized");
  return stripe.subscriptions.update(subscriptionId, {
    items: [{ id: itemId, deleted: true }],
    proration_behavior: "create_prorations",
  });
}

// ── Webhook signature verification ──────────────────────────────────────

export function constructWebhookEvent(
  payload: string | Buffer,
  signature: string
): Stripe.Event {
  if (!stripe) throw new Error("Stripe not initialized");
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET not configured");
  return stripe.webhooks.constructEvent(payload, signature, secret);
}

// ── Retrieve ────────────────────────────────────────────────────────────

export async function getSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
  if (!stripe) throw new Error("Stripe not initialized");
  return stripe.subscriptions.retrieve(subscriptionId);
}

export async function getCustomer(customerId: string): Promise<Stripe.Customer> {
  if (!stripe) throw new Error("Stripe not initialized");
  const customer = await stripe.customers.retrieve(customerId);
  if (customer.deleted) throw new Error("Customer has been deleted");
  return customer as Stripe.Customer;
}
