/*
 * One-time migration: move trial-era sites onto the free plan.
 *
 * Cohort: every site whose subscription has `hasEverPaid = false` — i.e. users
 * still trialing AND users whose trial already ended (now billing-suspended /
 * past_due / unpaid). Real paying customers (hasEverPaid = true) are excluded.
 *
 * For each migrated site it:
 *   1. Cancels the Stripe subscription immediately, so the trial can't convert
 *      and charge a card, and our own webhooks can't later flip the site back
 *      to a paid plan or suspend it.
 *   2. Marks the local subscription row `canceled`.
 *   3. Sets plan=free, preserving the current status (active stays active,
 *      onboarding stays onboarding). A *billing* suspension is cleared back to
 *      active so the site is writable again. (Note: status="free" would trip
 *      enforceActiveSite and lock the site read-only; the free state is
 *      plan=free with a writable status.)
 *   4. Writes an audit-log row.
 *   5. Emails the owner announcing the free plan.
 *
 * FLAGGED and skipped — never touched, surfaced for manual review:
 *   - sites in PROTECTED_SITE_IDS (e.g. the main cadmus.digital site),
 *   - sites suspended for a NON-billing reason (admin/abuse),
 *   - archived / pending hard-delete sites,
 *   - sites on a paid plan (monthly/annual) with hasEverPaid=false, which is
 *     contradictory and must not be silently downgraded.
 *
 * Idempotent: a site already in the target state (plan=free, status active,
 * subscription canceled) is reported as already-done and left untouched, so
 * re-runs don't re-email anyone.
 *
 * DEFAULTS TO DRY-RUN — prints the full cohort and the planned action for each
 * site, and changes nothing. Pass --apply to execute.
 *
 * Run:
 *   npx tsx apps/api/src/scripts/migrate-trialing-to-free.ts            # dry-run
 *   npx tsx apps/api/src/scripts/migrate-trialing-to-free.ts --apply    # execute
 *   npx tsx apps/api/src/scripts/migrate-trialing-to-free.ts --apply --skip-emails
 *
 * Env: DATABASE_URL (required)
 *      STRIPE_SECRET_KEY (required for --apply — needed to cancel subscriptions)
 *      MAILGUN_API_KEY + MAILGUN_DOMAIN (required for --apply unless --skip-emails)
 */

import { eq, and } from "drizzle-orm";
import { db, sites, subscriptions, siteMembers, users, auditLog } from "@cadmus/db";
import { MailgunEmailProvider } from "@cadmus/cloud";
import { initStripe, cancelSubscription } from "../lib/stripe.js";

const APPLY = process.argv.includes("--apply");
const SKIP_EMAILS = process.argv.includes("--skip-emails");

// Sites that must never be migrated, regardless of their plan/subscription
// state. The main cadmus.digital marketing site carries a never-paid annual
// subscription; downgrading it would break the primary site.
const PROTECTED_SITE_IDS = new Set<string>([
  "8b0f00c2-0061-43ca-b648-47471e6e4782", // site-dfugum-4 — main cadmus.digital
]);

type Candidate = {
  siteId: string;
  subdomain: string;
  siteName: string;
  siteStatus: string;
  sitePlan: string;
  suspensionSource: string | null;
  archived: boolean;
  subId: string;
  stripeSubscriptionId: string | null;
  subStatus: string;
};

type Plan =
  | { action: "migrate"; reactivate: boolean }
  | { action: "already-free" }
  | { action: "flag"; reason: string };

// Decide what to do with a candidate based purely on its current state.
function classify(c: Candidate): Plan {
  // Hard-protected sites — never migrate, whatever their state.
  if (PROTECTED_SITE_IDS.has(c.siteId)) {
    return { action: "flag", reason: "protected site (do not migrate)" };
  }

  // Archived / pending hard-delete — never touch automatically.
  if (c.siteStatus === "archived" || c.archived) {
    return { action: "flag", reason: `archived (status=${c.siteStatus})` };
  }

  // Suspended for a non-billing reason — don't reactivate abuse/admin holds.
  if (c.siteStatus === "suspended" && c.suspensionSource !== "billing") {
    return { action: "flag", reason: `suspended by ${c.suspensionSource ?? "unknown"} (non-billing)` };
  }

  // A paid plan with no payment on record is contradictory — could be an
  // incomplete checkout, or a real customer whose hasEverPaid flag drifted.
  // Either way, don't silently downgrade it; surface it for manual review.
  if (c.sitePlan !== "free") {
    return { action: "flag", reason: `paid plan (${c.sitePlan}) but never paid — review` };
  }

  const subCanceled = c.subStatus === "canceled";
  const siteWritable = c.siteStatus === "active" || c.siteStatus === "onboarding";

  // Already in the target end-state — nothing to do (keeps re-runs idempotent).
  if (c.sitePlan === "free" && siteWritable && subCanceled) {
    return { action: "already-free" };
  }

  // Sites already in a normal writable status keep it — active stays active,
  // and an onboarding site stays in onboarding (we must not yank it to active
  // mid-setup). Anything else that reaches here (a billing suspension, or a
  // stray non-writable status) gets flipped to active so the free site is
  // usable. reactivate=false therefore means "preserve the current status".
  return { action: "migrate", reactivate: !siteWritable };
}

async function main() {
  console.log(`migrate-trialing-to-free: ${APPLY ? "APPLY" : "DRY-RUN"}${SKIP_EMAILS ? " (skip-emails)" : ""}`);
  console.log("");

  // ── Cohort: trial-era subscriptions (never converted to a real payment) ────
  const rows = await db
    .select({
      siteId: sites.id,
      subdomain: sites.subdomain,
      siteName: sites.name,
      siteStatus: sites.status,
      sitePlan: sites.plan,
      suspensionSource: sites.suspensionSource,
      hardDeleteAt: sites.hardDeleteAt,
      subId: subscriptions.id,
      stripeSubscriptionId: subscriptions.stripeSubscriptionId,
      subStatus: subscriptions.status,
    })
    .from(sites)
    .innerJoin(subscriptions, eq(subscriptions.siteId, sites.id))
    .where(eq(subscriptions.hasEverPaid, false));

  const candidates: Candidate[] = rows.map((r) => ({
    siteId: r.siteId,
    subdomain: r.subdomain,
    siteName: r.siteName,
    siteStatus: r.siteStatus,
    sitePlan: r.sitePlan,
    suspensionSource: r.suspensionSource,
    archived: r.hardDeleteAt != null,
    subId: r.subId,
    stripeSubscriptionId: r.stripeSubscriptionId,
    subStatus: r.subStatus,
  }));

  const toMigrate = candidates.filter((c) => classify(c).action === "migrate");
  const alreadyFree = candidates.filter((c) => classify(c).action === "already-free");
  const flagged = candidates.filter((c) => classify(c).action === "flag");

  // ── Report the full cohort so it can be reviewed before --apply ────────────
  console.log(`Cohort (hasEverPaid = false): ${candidates.length} site(s)`);
  console.log("");
  for (const c of candidates) {
    const plan = classify(c);
    const tag =
      plan.action === "migrate"
        ? plan.reactivate
          ? "MIGRATE (reactivate)"
          : "MIGRATE"
        : plan.action === "already-free"
          ? "skip — already free"
          : `FLAG — ${plan.reason}`;
    console.log(
      `  [${tag}] ${c.subdomain}  site=${c.siteStatus}/${c.sitePlan}  sub=${c.subStatus}  (${c.siteId})`,
    );
  }
  console.log("");
  console.log(`  to migrate:   ${toMigrate.length}`);
  console.log(`  already free: ${alreadyFree.length}`);
  console.log(`  flagged:      ${flagged.length}  (need manual review — not touched)`);
  console.log("");

  if (!APPLY) {
    console.log("DRY-RUN — nothing changed. Re-run with --apply to execute.");
    return;
  }

  if (toMigrate.length === 0) {
    console.log("Nothing to migrate.");
    return;
  }

  // ── Preconditions for a real run ───────────────────────────────────────────
  const stripe = initStripe();
  if (!stripe) {
    console.error(
      "ERROR: STRIPE_SECRET_KEY not set. Cannot cancel subscriptions; aborting to avoid leaving live trials that would reverse this migration.",
    );
    process.exit(1);
  }

  const mailgunKey = process.env.MAILGUN_API_KEY;
  const mailgunDomain = process.env.MAILGUN_DOMAIN;
  const emailProvider =
    mailgunKey && mailgunDomain
      ? new MailgunEmailProvider({ apiKey: mailgunKey, domain: mailgunDomain })
      : null;

  if (!emailProvider && !SKIP_EMAILS) {
    console.error(
      "ERROR: MAILGUN_API_KEY / MAILGUN_DOMAIN not set. Refusing to migrate users without notifying them. Set the env vars, or pass --skip-emails to switch without sending email.",
    );
    process.exit(1);
  }

  const from = `Cadmus <noreply@${mailgunDomain || "cadmus.digital"}>`;

  let migrated = 0;
  let stripeCanceled = 0;
  let emailsSent = 0;
  const failures: string[] = [];

  for (const c of toMigrate) {
    const plan = classify(c);
    if (plan.action !== "migrate") continue; // type narrow; cohort already filtered

    try {
      // 1. Cancel the Stripe subscription *immediately* so it can't convert,
      //    charge, or fire webhooks that undo this migration.
      if (c.stripeSubscriptionId) {
        try {
          await cancelSubscription(c.stripeSubscriptionId, false);
          stripeCanceled++;
        } catch (err) {
          // Already canceled / not found in Stripe is fine — keep going.
          console.warn(`  ! Stripe cancel for ${c.subdomain} (${c.stripeSubscriptionId}): ${(err as Error).message}`);
        }
      }

      // 2. Mark the local subscription canceled.
      await db
        .update(subscriptions)
        .set({ status: "canceled", updatedAt: new Date() })
        .where(eq(subscriptions.id, c.subId));

      // 3. Flip the site to the free plan. Clear a billing suspension so the
      //    site is writable; never change status for non-suspended sites except
      //    to keep them active.
      const siteUpdate: Record<string, unknown> = {
        plan: "free",
        planEndsAt: null,
        updatedAt: new Date(),
      };
      // Preserve a normal status (active stays active, onboarding stays
      // onboarding). Only force-activate and clear suspension fields when the
      // site was suspended / otherwise non-writable.
      if (plan.reactivate) {
        siteUpdate.status = "active";
        siteUpdate.suspendedAt = null;
        siteUpdate.suspensionReason = null;
        siteUpdate.suspensionSource = null;
      }
      await db.update(sites).set(siteUpdate).where(eq(sites.id, c.siteId));

      // 4. Audit log — every mutation gets an actor + before/after detail.
      await db.insert(auditLog).values({
        siteId: c.siteId,
        actorType: "system",
        action: "billing.migrated_to_free",
        entityType: "site",
        entityId: c.siteId,
        details: {
          previousPlan: c.sitePlan,
          previousStatus: c.siteStatus,
          previousSubStatus: c.subStatus,
          reactivated: plan.reactivate,
          stripeSubscriptionId: c.stripeSubscriptionId,
        },
      });

      migrated++;

      // 5. Notify the owner.
      const [owner] = await db
        .select({ email: users.email, firstName: users.firstName })
        .from(siteMembers)
        .innerJoin(users, eq(siteMembers.userId, users.id))
        .where(
          and(
            eq(siteMembers.siteId, c.siteId),
            eq(siteMembers.role, "owner"),
            eq(siteMembers.status, "active"),
          ),
        )
        .limit(1);

      console.log(
        `  ✓ ${c.subdomain}${plan.reactivate ? " (reactivated)" : ""} — owner: ${owner?.email ?? "(no owner found)"}`,
      );

      if (emailProvider && !SKIP_EMAILS && owner?.email) {
        const greeting = owner.firstName ? `Hi ${owner.firstName},` : "Hi,";
        const html = `
<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:2rem;color:#1a1a1a">
  <p>${greeting}</p>
  <p>Good news — we've launched a free plan! Your account has been moved to Cadmus Free.</p>
  <p>You get:</p>
  <ul>
    <li>5 AI-designed pages with images</li>
    <li>10 AI chat messages per day</li>
    <li>10 AI-generated images per month</li>
    <li>250MB storage</li>
    <li>100 form notification emails per month</li>
  </ul>
  <p>Ready for more? Upgrade anytime from your site settings.</p>
  <p>Questions? Reply to this email.</p>
</div>`;

        try {
          await emailProvider.send({
            to: owner.email,
            from,
            subject: "Your Cadmus trial has been converted to our free plan",
            html,
          });
          emailsSent++;
        } catch (emailErr) {
          console.error(`  ! Failed to email ${owner.email}:`, emailErr);
          failures.push(`email:${c.subdomain}`);
        }
      }
    } catch (err) {
      console.error(`  ✗ Error migrating ${c.subdomain} (${c.siteId}):`, err);
      failures.push(`migrate:${c.subdomain}`);
    }
  }

  console.log("");
  console.log("─────────────────────────────────────");
  console.log(`Migrated:          ${migrated}`);
  console.log(`Stripe canceled:   ${stripeCanceled}`);
  console.log(`Emails sent:       ${emailsSent}`);
  console.log(`Flagged (skipped): ${flagged.length}`);
  console.log(`Failures:          ${failures.length}${failures.length ? ` — ${failures.join(", ")}` : ""}`);
  console.log("─────────────────────────────────────");

  if (failures.length) process.exit(1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
