import { eq, and } from "drizzle-orm";
import { db, sites, users, siteMembers, auditLog } from "@cadmus/db";
import { getEmailProvider } from "./email.js";

export type SuspensionSource = "admin" | "billing";

export type Actor = { type: "user"; id: string } | { type: "system"; id?: null };

export type EmailKind =
  | "admin-suspend"
  | "admin-reinstate"
  | "trial-expired"
  | "payment-failed"
  | "past-due-nudge"
  | "billing-reinstate";

type Site = typeof sites.$inferSelect;

// ── Suspend ────────────────────────────────────────────────────────────────

export async function suspendSite(params: {
  siteId: string;
  source: SuspensionSource;
  reason: string;
  actor: Actor;
  emailKind: EmailKind;
}): Promise<
  { site: Site; skipped?: "already-suspended" | "site-missing" | "billing-free" }
> {
  const { siteId, source, reason, actor, emailKind } = params;

  const [site] = await db.select().from(sites).where(eq(sites.id, siteId));
  if (!site) return { site: null as unknown as Site, skipped: "site-missing" };

  // Free sites are not billable — never let a billing webhook (failed payment,
  // trial-end, etc.) take them down. Admin suspensions still apply.
  if (source === "billing" && site.billing === "free") {
    return { site, skipped: "billing-free" };
  }

  // Idempotent: already suspended → no-op (don't overwrite source/reason).
  if (site.status === "suspended") {
    return { site, skipped: "already-suspended" };
  }

  const now = new Date();
  const [updated] = await db
    .update(sites)
    .set({
      status: "suspended",
      suspendedAt: now,
      suspensionReason: reason,
      suspensionSource: source,
      updatedAt: now,
    })
    .where(eq(sites.id, siteId))
    .returning();

  await db.insert(auditLog).values({
    siteId,
    actorType: actor.type,
    actorId: actor.type === "user" ? actor.id : null,
    action: "site.suspended",
    entityType: "site",
    entityId: siteId,
    details: {
      previousStatus: site.status,
      newStatus: "suspended",
      source,
      reason,
    },
  });

  await sendOwnerEmail({ site: updated, kind: emailKind, reason });
  return { site: updated };
}

// ── Reinstate ──────────────────────────────────────────────────────────────

export async function reinstateSite(params: {
  siteId: string;
  actor: Actor;
  emailKind: EmailKind;
  onlyIfSource?: SuspensionSource; // e.g. "billing" — skip admin-suspensions
}): Promise<{ site: Site; skipped?: "not-suspended" | "source-mismatch" | "site-missing" }> {
  const { siteId, actor, emailKind, onlyIfSource } = params;

  const [site] = await db.select().from(sites).where(eq(sites.id, siteId));
  if (!site) return { site: null as unknown as Site, skipped: "site-missing" };

  if (site.status !== "suspended") {
    return { site, skipped: "not-suspended" };
  }
  if (onlyIfSource && site.suspensionSource !== onlyIfSource) {
    return { site, skipped: "source-mismatch" };
  }

  const now = new Date();
  const [updated] = await db
    .update(sites)
    .set({
      status: "active",
      suspendedAt: null,
      suspensionReason: null,
      suspensionSource: null,
      updatedAt: now,
    })
    .where(eq(sites.id, siteId))
    .returning();

  await db.insert(auditLog).values({
    siteId,
    actorType: actor.type,
    actorId: actor.type === "user" ? actor.id : null,
    action: "site.reinstated",
    entityType: "site",
    entityId: siteId,
    details: {
      previousStatus: "suspended",
      newStatus: "active",
      previousSource: site.suspensionSource,
    },
  });

  await sendOwnerEmail({ site: updated, kind: emailKind });
  return { site: updated };
}

// ── Past-due nudge (no status change) ──────────────────────────────────────
// Sends the "update your card" email. Still leaves Stripe Smart Retries running.

export async function nudgePastDue(params: { siteId: string }): Promise<void> {
  const { siteId } = params;
  const [site] = await db.select().from(sites).where(eq(sites.id, siteId));
  if (!site) return;
  await sendOwnerEmail({ site, kind: "past-due-nudge" });
}

// ── Email ──────────────────────────────────────────────────────────────────

async function sendOwnerEmail(params: { site: Site; kind: EmailKind; reason?: string }) {
  const { site, kind, reason } = params;

  const provider = getEmailProvider();
  if (!provider) return;

  const [owner] = await db
    .select({ email: users.email, firstName: users.firstName })
    .from(siteMembers)
    .innerJoin(users, eq(siteMembers.userId, users.id))
    .where(
      and(
        eq(siteMembers.siteId, site.id),
        eq(siteMembers.role, "owner"),
        eq(siteMembers.status, "active"),
      ),
    )
    .limit(1);

  if (!owner?.email) return;

  const from = `Cadmus <noreply@${process.env.MAILGUN_DOMAIN || "cadmus.digital"}>`;
  const baseDomain = process.env.BASE_DOMAIN || "cadmus.digital";
  const name = owner.firstName || owner.email.split("@")[0];
  const greeting = `Hi ${name},`;
  const accountUrl = `https://${baseDomain}/admin/account`;

  const { subject, body } = renderEmail({ kind, siteName: site.name, greeting, reason, accountUrl });

  provider
    .send({
      to: owner.email,
      from,
      subject,
      html: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:2rem;color:#1a1a1a">${body}</div>`,
    })
    .catch((err) => console.error(`Failed to send ${kind} email:`, err));
}

function renderEmail(p: {
  kind: EmailKind;
  siteName: string;
  greeting: string;
  reason?: string;
  accountUrl: string;
}): { subject: string; body: string } {
  const { kind, siteName, greeting, reason, accountUrl } = p;
  const support = `<a href="mailto:support@cadmus.digital">support@cadmus.digital</a>`;

  switch (kind) {
    case "admin-suspend":
      return {
        subject: `Your site "${siteName}" has been suspended`,
        body: `
          <p>${greeting}</p>
          <p>Your Cadmus site <strong>${siteName}</strong> has been suspended by the Cadmus team.</p>
          <p><strong>Reason:</strong> ${reason}</p>
          <p>While suspended, your site is read-only — you can still sign in and view content, but editing and publishing are disabled. Public visitors will see a suspension notice.</p>
          <p>If you believe this is in error, reply to this email or contact ${support}.</p>
        `,
      };
    case "admin-reinstate":
      return {
        subject: `Your site "${siteName}" has been reinstated`,
        body: `
          <p>${greeting}</p>
          <p>Good news — your Cadmus site <strong>${siteName}</strong> has been reinstated. All features are available again.</p>
          <p>Thanks for being part of Cadmus.</p>
        `,
      };
    case "trial-expired":
      return {
        subject: `Your trial for "${siteName}" is complete`,
        body: `
          <p>${greeting}</p>
          <p>Your free trial of Cadmus for <strong>${siteName}</strong> has ended, and we didn't have a payment method on file to continue your subscription.</p>
          <p>Your site is now suspended and the public URL shows an unavailable notice — but your content, media, and settings are all safe.</p>
          <p>To keep your site online, add a payment method and your site will come back automatically:</p>
          <p><a href="${accountUrl}" style="display:inline-block;padding:0.75rem 1.25rem;background:#1a1a1a;color:#fff;border-radius:0.5rem;text-decoration:none">Add payment method</a></p>
          <p>Questions? Reach us at ${support}.</p>
        `,
      };
    case "past-due-nudge":
      return {
        subject: `Payment failed for "${siteName}" — please update your card`,
        body: `
          <p>${greeting}</p>
          <p>We tried to charge the payment method on file for <strong>${siteName}</strong> and it was declined.</p>
          <p>Don't worry — your site is still online. Stripe will retry automatically over the next couple of weeks, but if those attempts also fail your site will be suspended.</p>
          <p>The quickest fix is to update your payment method now:</p>
          <p><a href="${accountUrl}" style="display:inline-block;padding:0.75rem 1.25rem;background:#1a1a1a;color:#fff;border-radius:0.5rem;text-decoration:none">Update payment method</a></p>
          <p>Questions? Reach us at ${support}.</p>
        `,
      };
    case "payment-failed":
      return {
        subject: `Your site "${siteName}" has been suspended — payment failed`,
        body: `
          <p>${greeting}</p>
          <p>Your payment method on file for <strong>${siteName}</strong> has failed after multiple attempts, so we've suspended your site.</p>
          <p>Your content, media, and settings are all safe. To get your site back online, add a new payment method and your subscription (and site) will resume automatically:</p>
          <p><a href="${accountUrl}" style="display:inline-block;padding:0.75rem 1.25rem;background:#1a1a1a;color:#fff;border-radius:0.5rem;text-decoration:none">Add payment method</a></p>
          <p>Need help? Reach us at ${support}.</p>
        `,
      };
    case "billing-reinstate":
      return {
        subject: `Your site "${siteName}" is back online`,
        body: `
          <p>${greeting}</p>
          <p>Thanks — we received your payment and <strong>${siteName}</strong> is back online. All features are available again.</p>
          <p>Thanks for being part of Cadmus.</p>
        `,
      };
  }
}
