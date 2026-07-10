import { Hono } from "hono";
import { eq, and, like, or, sql, desc, count, lte, isNotNull, lt } from "drizzle-orm";
import {
  db,
  sites,
  users,
  siteMembers,
  subscriptions,
  paymentMethods,
  partners,
  partnerSites,
  referrals,
  auditLog,
  aiHistory,
  content,
  contentVersions,
  contentBlocks,
  contentCollections,
  contentMedia,
  collections,
  media,
  navigation,
  scheduledTasks,
  formSubmissions,
  promotions,
  promoRedemptions,
} from "@cadmus/db";
import crypto from "node:crypto";
import type { AuthUser } from "@cadmus/shared";
import { getEmailProvider } from "../lib/email.js";
import { hashToken } from "../lib/tokens.js";
import { logError } from "../lib/log.js";
import { signHandoffToken } from "../lib/handoff.js";
import { suspendSite, reinstateSite } from "../lib/site-lifecycle.js";
import { archiveContentForRestart } from "../lib/onboarding-archive.js";
import { getStorageProvider, getStagingStorageProvider } from "./media.js";
import { signMediaStreamToken } from "../lib/media-stream-token.js";
import { compileTailwindForTheme } from "@cadmus/ai";
import { parse as parseHtml } from "node-html-parser";

const ALLOWED_STATUS_TRANSITIONS: Record<string, string[]> = {
  active: ["suspended", "archived"],
  suspended: ["active", "archived"],
  archived: ["active"],
  onboarding: ["active", "suspended", "archived"],
};

const ALLOWED_GRACE_DAYS = new Set([30, 60, 90]);

export const adminRoutes = new Hono<{ Variables: { user: AuthUser } }>();

// ── GET /stats — platform-wide aggregate counts ─────────────────────────────

adminRoutes.get("/stats", async (c) => {
  const [
    [{ value: totalSites }],
    [{ value: totalUsers }],
    [{ value: activeSubscriptions }],
    [{ value: trials }],
    [{ value: totalPartners }],
    [{ value: totalReferrals }],
  ] = await Promise.all([
    db.select({ value: count() }).from(sites),
    db.select({ value: count() }).from(users),
    db.select({ value: count() }).from(subscriptions).where(eq(subscriptions.status, "active")),
    db.select({ value: count() }).from(subscriptions).where(eq(subscriptions.status, "trialing")),
    db.select({ value: count() }).from(partners),
    db.select({ value: count() }).from(referrals),
  ]);

  return c.json({
    sites: totalSites,
    users: totalUsers,
    activeSubscriptions,
    trials,
    partners: totalPartners,
    referrals: totalReferrals,
  });
});

// ── GET /sites — paginated site list ────────────────────────────────────────

adminRoutes.get("/sites", async (c) => {
  const page = Math.max(1, Number(c.req.query("page")) || 1);
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 25));
  const search = c.req.query("search")?.trim() || "";
  const statusFilter = c.req.query("status") || "";
  const offset = (page - 1) * limit;

  const conditions = [];
  if (search) {
    const pattern = `%${search}%`;
    conditions.push(or(like(sites.name, pattern), like(sites.subdomain, pattern)));
  }
  if (statusFilter) {
    conditions.push(eq(sites.status, statusFilter));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [items, [{ value: total }]] = await Promise.all([
    db
      .select({
        id: sites.id,
        name: sites.name,
        subdomain: sites.subdomain,
        domain: sites.domain,
        status: sites.status,
        createdAt: sites.createdAt,
        subscriptionStatus: subscriptions.status,
        trialEndsAt: subscriptions.trialEndsAt,
      })
      .from(sites)
      .leftJoin(subscriptions, eq(sites.id, subscriptions.siteId))
      .where(where)
      .orderBy(desc(sites.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ value: count() }).from(sites).where(where),
  ]);

  // Fetch owners for these sites
  const siteIds = items.map((s) => s.id);
  const owners =
    siteIds.length > 0
      ? await db
          .select({
            siteId: siteMembers.siteId,
            email: users.email,
            firstName: users.firstName,
            lastName: users.lastName,
          })
          .from(siteMembers)
          .innerJoin(users, eq(siteMembers.userId, users.id))
          .where(and(eq(siteMembers.role, "owner"), eq(siteMembers.status, "active")))
      : [];

  const ownerBySite = new Map(owners.map((o) => [o.siteId, o]));

  const enriched = items.map((s) => {
    const owner = ownerBySite.get(s.id);
    return {
      ...s,
      ownerEmail: owner?.email || null,
      ownerName: owner ? `${owner.firstName || ""} ${owner.lastName || ""}`.trim() || owner.email : null,
    };
  });

  return c.json({
    items: enriched,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
});

// ── POST /sites/:id/access — mint a session-handoff token ───────────────────
// Lets the dashboard open a site's admin app (different origin) as the current
// cadmus_admin. The mount already restricts this to cadmus_admin.

adminRoutes.post("/sites/:id/access", async (c) => {
  const siteId = c.req.param("id");
  const user = c.get("user");
  const [site] = await db.select({ id: sites.id }).from(sites).where(eq(sites.id, siteId));
  if (!site) return c.json({ error: "Site not found" }, 404);
  const token = await signHandoffToken(user.id, siteId);
  return c.json({ token });
});

// ── GET /sites/:id — site detail ────────────────────────────────────────────

adminRoutes.get("/sites/:id", async (c) => {
  const siteId = c.req.param("id");

  const [siteRows, subRows, team, recentActivity, [{ value: contentCount }], [{ value: mediaCount }]] =
    await Promise.all([
      db.select().from(sites).where(eq(sites.id, siteId)),
      db.select().from(subscriptions).where(eq(subscriptions.siteId, siteId)),
      db
        .select({
          id: siteMembers.id,
          userId: siteMembers.userId,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          role: siteMembers.role,
          status: siteMembers.status,
          joinedAt: siteMembers.joinedAt,
        })
        .from(siteMembers)
        .innerJoin(users, eq(siteMembers.userId, users.id))
        .where(eq(siteMembers.siteId, siteId)),
      db
        .select()
        .from(auditLog)
        .where(eq(auditLog.siteId, siteId))
        .orderBy(desc(auditLog.createdAt))
        .limit(20),
      db.select({ value: count() }).from(content).where(eq(content.siteId, siteId)),
      db.select({ value: count() }).from(media).where(eq(media.siteId, siteId)),
    ]);

  if (siteRows.length === 0) {
    return c.json({ error: "Site not found" }, 404);
  }

  return c.json({
    site: siteRows[0],
    subscription: subRows[0] || null,
    team,
    recentActivity,
    counts: { content: contentCount, media: mediaCount },
  });
});

// ── GET /sites/:id/theme-debug — diagnostic snapshot of theme + blocks ──────
//
// Summarizes the site's theme (fontFamilies, header/footer presence, compiled
// CSS size) and compares classes used across all block HTML against what got
// compiled into CSS. Returns the first 30 classes that are used but missing
// from compiled output so mismatches are easy to spot.

adminRoutes.get("/sites/:id/theme-debug", async (c) => {
  const siteId = c.req.param("id");
  const [siteRow] = await db.select().from(sites).where(eq(sites.id, siteId));
  if (!siteRow) return c.json({ error: "Site not found" }, 404);

  const pageRows = await db.select().from(content).where(eq(content.siteId, siteId));
  const blockRows = pageRows.length
    ? await db
        .select()
        .from(contentBlocks)
        .where(sql`${contentBlocks.contentId} IN (${sql.join(pageRows.map((p) => sql`${p.id}`), sql`, `)})`)
    : [];

  const theme = ((siteRow.settings as Record<string, unknown>)?.theme ?? null) as
    | Record<string, unknown>
    | null;
  const compiledCss = (theme?.compiledCss as string | undefined) ?? "";

  const extractClasses = (html: string): Set<string> => {
    const out = new Set<string>();
    const root = parseHtml(html);
    for (const el of root.querySelectorAll("[class]")) {
      for (const c of (el.getAttribute("class") || "").split(/\s+/)) {
        if (c.trim()) out.add(c.trim());
      }
    }
    return out;
  };

  const classesInHtml = new Set<string>();
  for (const b of blockRows) {
    const html = (b.data as { html?: string } | undefined)?.html;
    if (html) for (const c of extractClasses(html)) classesInHtml.add(c);
  }
  if (theme?.headerHtml) for (const c of extractClasses(theme.headerHtml as string)) classesInHtml.add(c);
  if (theme?.footerHtml) for (const c of extractClasses(theme.footerHtml as string)) classesInHtml.add(c);

  // Tailwind escapes CSS-special chars in selectors (e.g. `lg:px-24` becomes
  // `.lg\:px-24`, `min-h-[921px]` becomes `.min-h-\[921px\]`). Build the
  // literal escaped selector and check for it as a substring in compiledCss,
  // verifying the following char is a selector delimiter so we don't match
  // a class that's a prefix of a longer one (e.g. `bg-primary` vs `bg-primary-dim`).
  // CSS selectors escape any non-ident char (anything outside [A-Za-z0-9_-])
  // with a leading backslash. Tailwind v4 follows this for variants, arbitrary
  // values, opacity, hex colors, font names, etc.
  const cssEscape = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, (c) => `\\${c}`);
  const isCompiled = (cls: string): boolean => {
    const needle = "." + cssEscape(cls);
    let from = 0;
    while (true) {
      const idx = compiledCss.indexOf(needle, from);
      if (idx === -1) return false;
      const next = compiledCss[idx + needle.length] ?? "";
      if (next === "" || /[\s{:,>+~]/.test(next)) return true;
      from = idx + 1;
    }
  };
  // Tailwind utilities that exist purely as parent markers and never emit
  // their own CSS rule. Filter them out so they don't pollute the report.
  const PARENT_MARKERS = new Set(["group", "peer"]);

  const missing: string[] = [];
  for (const cls of classesInHtml) {
    if (PARENT_MARKERS.has(cls)) continue;
    if (!isCompiled(cls)) missing.push(cls);
    if (missing.length >= 50) break;
  }

  const headerHtml = (theme?.headerHtml as string | undefined) ?? "";
  const footerHtml = (theme?.footerHtml as string | undefined) ?? "";

  return c.json({
    siteId,
    subdomain: siteRow.subdomain,
    theme: {
      fontFamilies: theme?.fontFamilies ?? null,
      colorsCount: Object.keys((theme?.colors as object) ?? {}).length,
      bodyClasses: theme?.bodyClasses ?? null,
      hasHeader: !!headerHtml,
      headerBytes: headerHtml.length,
      headerPreview: headerHtml.slice(0, 200),
      hasFooter: !!footerHtml,
      footerBytes: footerHtml.length,
      compiledCssBytes: compiledCss.length,
    },
    content: {
      pageCount: pageRows.length,
      blockCount: blockRows.length,
      blockTypes: blockRows.map((b) => ({ blockType: b.blockType, hasHtml: !!(b.data as { html?: string } | undefined)?.html })),
    },
    classAnalysis: {
      classesInHtml: classesInHtml.size,
      missingFromCss: missing,
    },
  });
});

// ── POST /sites/:id/recompile-theme — regenerate compiled Tailwind CSS ──────
//
// Loads the current theme + all block HTML from DB and runs the Tailwind
// compiler against them. Useful when compiled CSS drifts from block content
// (e.g. blocks were edited after the last compile).

adminRoutes.post("/sites/:id/recompile-theme", async (c) => {
  const siteId = c.req.param("id");
  const actor = c.get("user");
  const [siteRow] = await db.select().from(sites).where(eq(sites.id, siteId));
  if (!siteRow) return c.json({ error: "Site not found" }, 404);

  const settings = (siteRow.settings as Record<string, unknown>) ?? {};
  const theme = (settings.theme ?? null) as Record<string, unknown> | null;
  if (!theme) return c.json({ error: "Site has no theme to recompile" }, 400);

  const pageRows = await db.select().from(content).where(eq(content.siteId, siteId));
  const blockRows = pageRows.length
    ? await db
        .select()
        .from(contentBlocks)
        .where(sql`${contentBlocks.contentId} IN (${sql.join(pageRows.map((p) => sql`${p.id}`), sql`, `)})`)
    : [];

  const before = ((theme.compiledCss as string | undefined) ?? "").length;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const css = await compileTailwindForTheme(theme as any, blockRows as any);
  const updatedTheme = { ...theme, compiledCss: css };
  const updatedSettings = { ...settings, theme: updatedTheme };

  await db.update(sites).set({ settings: updatedSettings }).where(eq(sites.id, siteId));
  await db.insert(auditLog).values({
    siteId,
    actorType: "user",
    actorId: actor.id,
    action: "theme.recompile",
    entityType: "site",
    entityId: siteId,
    details: { beforeBytes: before, afterBytes: css.length, blockCount: blockRows.length },
  });

  return c.json({ ok: true, beforeBytes: before, afterBytes: css.length, blockCount: blockRows.length });
});

// ── PATCH /sites/:id/status — change site status (suspend/reinstate) ────────

adminRoutes.patch("/sites/:id/status", async (c) => {
  const siteId = c.req.param("id");
  const user = c.get("user");
  const body = await c.req.json<{ status?: string; reason?: string; graceDays?: number }>();

  const nextStatus = body.status?.trim();
  if (!nextStatus) {
    return c.json({ error: "status is required" }, 400);
  }

  const [site] = await db.select().from(sites).where(eq(sites.id, siteId));
  if (!site) return c.json({ error: "Site not found" }, 404);

  if (site.status === nextStatus) {
    return c.json({ error: `Site is already ${nextStatus}` }, 400);
  }

  const allowed = ALLOWED_STATUS_TRANSITIONS[site.status] || [];
  if (!allowed.includes(nextStatus)) {
    return c.json(
      { error: `Cannot transition site from ${site.status} to ${nextStatus}` },
      400,
    );
  }

  if (nextStatus === "suspended" && !body.reason?.trim()) {
    return c.json({ error: "reason is required when suspending a site" }, 400);
  }
  if (nextStatus === "archived" && !body.reason?.trim()) {
    return c.json({ error: "reason is required when archiving a site" }, 400);
  }

  let graceDays: number | null = null;
  let hardDeleteAt: Date | null = null;
  if (nextStatus === "archived") {
    graceDays = body.graceDays ?? 30;
    if (!ALLOWED_GRACE_DAYS.has(graceDays)) {
      return c.json({ error: "graceDays must be 30, 60, or 90" }, 400);
    }
    hardDeleteAt = new Date(Date.now() + graceDays * 24 * 60 * 60 * 1000);
  }

  // Suspend/reinstate go through the site-lifecycle helpers so the admin
  // route and the billing webhooks share a single implementation.
  if (nextStatus === "suspended") {
    const { site: updated } = await suspendSite({
      siteId,
      source: "admin",
      reason: body.reason!.trim(),
      actor: { type: "user", id: user.id },
      emailKind: "admin-suspend",
    });
    return c.json({ site: updated });
  }
  if (nextStatus === "active" && site.status === "suspended") {
    const { site: updated } = await reinstateSite({
      siteId,
      actor: { type: "user", id: user.id },
      emailKind: "admin-reinstate",
    });
    return c.json({ site: updated });
  }

  // Archive / restore paths stay inline — different state machine.
  const now = new Date();
  const updates: Record<string, unknown> = { status: nextStatus, updatedAt: now };
  if (nextStatus === "archived") {
    updates.archivedAt = now;
    updates.archiveReason = body.reason!.trim();
    updates.hardDeleteAt = hardDeleteAt;
  } else if (nextStatus === "active" && site.status === "archived") {
    updates.archivedAt = null;
    updates.archiveReason = null;
    updates.hardDeleteAt = null;
  }

  const [updated] = await db.update(sites).set(updates).where(eq(sites.id, siteId)).returning();

  const action = nextStatus === "archived" ? "site.archived" : "site.restored";

  await db.insert(auditLog).values({
    siteId,
    actorType: "user",
    actorId: user.id,
    action,
    entityType: "site",
    entityId: siteId,
    details: {
      previousStatus: site.status,
      newStatus: nextStatus,
      reason: body.reason?.trim() || null,
      graceDays,
      hardDeleteAt: hardDeleteAt?.toISOString() || null,
    },
  });

  // Notify site owner (fire-and-forget; don't block response on email).
  const emailProvider = getEmailProvider();
  if (emailProvider) {
    const [owner] = await db
      .select({ email: users.email, firstName: users.firstName })
      .from(siteMembers)
      .innerJoin(users, eq(siteMembers.userId, users.id))
      .where(
        and(
          eq(siteMembers.siteId, siteId),
          eq(siteMembers.role, "owner"),
          eq(siteMembers.status, "active"),
        ),
      )
      .limit(1);

    if (owner?.email) {
      const from = `Cadmus <noreply@${process.env.MAILGUN_DOMAIN || "cadmus.digital"}>`;
      const greeting = owner.firstName ? `Hi ${owner.firstName},` : "Hi,";

      let subject: string;
      let bodyHtml: string;
      if (nextStatus === "archived") {
        const deleteDateStr = hardDeleteAt!.toLocaleDateString("en-US", {
          month: "long",
          day: "numeric",
          year: "numeric",
        });
        subject = `Your site "${site.name}" has been archived`;
        bodyHtml = `
          <p>${greeting}</p>
          <p>Your Cadmus site <strong>${site.name}</strong> has been archived.</p>
          <p><strong>Reason:</strong> ${updates.archiveReason}</p>
          <p>Your site and all its content will be permanently deleted on <strong>${deleteDateStr}</strong> (${graceDays} days from now). Until then, the site is read-only and the public URL returns an unavailable notice.</p>
          <p>If you want to restore the site before then, contact <a href="mailto:support@cadmus.digital">support@cadmus.digital</a>.</p>
        `;
      } else {
        subject = `Your site "${site.name}" has been restored`;
        bodyHtml = `
          <p>${greeting}</p>
          <p>Good news — your Cadmus site <strong>${site.name}</strong> has been restored from archive. Scheduled deletion is cancelled and the site is active again.</p>
        `;
      }

      emailProvider
        .send({
          to: owner.email,
          from,
          subject,
          html: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:2rem;color:#1a1a1a">${bodyHtml}</div>`,
        })
        .catch((err) => console.error("Failed to send status-change email:", err));
    }
  }

  return c.json({ site: updated });
});

// Note: a site's billing mode is no longer set independently. It's derived from
// the plan via the staff override (PUT /sites/:id/override): plan "comped" ⇒
// billing "free" (internal/forever-free, no Stripe), any other plan ⇒ "standard".
// This replaced the old PATCH /sites/:id/billing toggle, which conflated the
// free *tier* with forever-free *internal* sites.

// ── POST /sites/:id/restart-onboarding — reset site to onboarding status ───
// Same semantics as the site-scoped endpoint, but callable cross-tenant by
// cadmus_admin. Existing content is archived (slug renamed to `-old`,
// status flipped to draft) so the new onboarding pass can create fresh
// pages without slug collisions. Owner is emailed.

adminRoutes.post("/sites/:id/restart-onboarding", async (c) => {
  const siteId = c.req.param("id");
  const user = c.get("user");

  const [site] = await db.select().from(sites).where(eq(sites.id, siteId));
  if (!site) return c.json({ error: "Site not found" }, 404);

  if (site.status !== "active") {
    return c.json(
      { error: `Cannot restart onboarding for a ${site.status} site` },
      400,
    );
  }

  const settings = (site.settings as Record<string, unknown>) || {};
  delete settings.skippedOnboarding;
  // Drop the existing theme so the new wizard pass produces fresh colors,
  // fonts, header/footer HTML, and Stitch project state. See sites.ts
  // restart-onboarding for the full rationale.
  delete settings.theme;

  const { updated, archived } = await db.transaction(async (tx) => {
    const archivedRows = await archiveContentForRestart(tx, siteId);

    const [row] = await tx
      .update(sites)
      .set({ status: "onboarding", brief: null, settings, updatedAt: new Date() })
      .where(eq(sites.id, siteId))
      .returning();

    await tx.insert(auditLog).values({
      siteId,
      actorType: "user",
      actorId: user.id,
      action: "site.restart_onboarding",
      entityType: "site",
      entityId: siteId,
      details: {
        triggeredByAdmin: true,
        archivedCount: archivedRows.length,
        archived: archivedRows,
      },
    });

    return { updated: row, archived: archivedRows };
  });

  // Notify owner (fire-and-forget)
  const emailProvider = getEmailProvider();
  if (emailProvider) {
    const [owner] = await db
      .select({ email: users.email, firstName: users.firstName })
      .from(siteMembers)
      .innerJoin(users, eq(siteMembers.userId, users.id))
      .where(
        and(
          eq(siteMembers.siteId, siteId),
          eq(siteMembers.role, "owner"),
          eq(siteMembers.status, "active"),
        ),
      )
      .limit(1);

    if (owner?.email) {
      const from = `Cadmus <noreply@${process.env.MAILGUN_DOMAIN || "cadmus.digital"}>`;
      const greeting = owner.firstName ? `Hi ${owner.firstName},` : "Hi,";
      emailProvider
        .send({
          to: owner.email,
          from,
          subject: `Onboarding has been restarted for "${site.name}"`,
          html: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:2rem;color:#1a1a1a">
            <p>${greeting}</p>
            <p>The onboarding flow has been restarted for your Cadmus site <strong>${site.name}</strong>. The new onboarding wizard will generate a fresh set of pages.${archived.length > 0 ? ` Your previous ${archived.length === 1 ? "page" : `${archived.length} pages`} have been preserved as drafts (renamed with an <code>-old</code> suffix), so you can recover them at any time.` : ""}</p>
            <p>Next time you sign in, you'll be taken to the onboarding wizard.</p>
          </div>`,
        })
        .catch((err) => console.error("Failed to send restart-onboarding email:", err));
    }
  }

  return c.json({ site: updated, archivedCount: archived.length });
});

// ── POST /maintenance/expire-archives — hard-delete expired archives ────────
// Intended to be invoked by a scheduled job (Cloud Scheduler → this endpoint).
// Finds archived sites whose grace period has lapsed and deletes all their data.
// Pass ?dryRun=true to preview what would be deleted without mutating anything.

adminRoutes.post("/maintenance/expire-archives", async (c) => {
  const now = new Date();
  const dryRun = c.req.query("dryRun") === "true";

  const expired = await db
    .select({
      id: sites.id,
      name: sites.name,
      subdomain: sites.subdomain,
      archivedAt: sites.archivedAt,
      hardDeleteAt: sites.hardDeleteAt,
    })
    .from(sites)
    .where(
      and(
        eq(sites.status, "archived"),
        isNotNull(sites.hardDeleteAt),
        lte(sites.hardDeleteAt, now),
      ),
    );

  if (dryRun) {
    const previews = await Promise.all(
      expired.map(async (row) => ({
        siteId: row.id,
        name: row.name,
        subdomain: row.subdomain,
        archivedAt: row.archivedAt,
        hardDeleteAt: row.hardDeleteAt,
        wouldDelete: await countSiteRows(row.id),
      })),
    );
    return c.json({ dryRun: true, expired: expired.length, previews });
  }

  const results: { siteId: string; name: string; deleted: boolean; error?: string }[] = [];

  for (const row of expired) {
    try {
      await hardDeleteSite(row.id);
      results.push({ siteId: row.id, name: row.name, deleted: true });
    } catch (err) {
      console.error(`Failed to hard-delete site ${row.id}:`, err);
      results.push({
        siteId: row.id,
        name: row.name,
        deleted: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({ expired: expired.length, results });
});

// ── Media Review ─────────────────────────────────────────────────────────────

adminRoutes.get("/media-review", async (c) => {
  const status = c.req.query("status") ?? "review";
  const limit = Math.min(Number(c.req.query("limit") || 20), 100);
  const offset = Number(c.req.query("offset") || 0);
  const [items, countResult] = await Promise.all([
    db.select({ id: media.id, filename: media.filename, storageUrl: media.storageUrl, mimeType: media.mimeType, moderationStatus: media.moderationStatus, moderationScores: media.moderationScores, moderationReason: media.moderationReason, moderationSource: media.moderationSource, blockedAt: media.blockedAt, stagingPath: media.stagingPath, siteId: media.siteId, createdAt: media.createdAt, siteName: sites.name })
      .from(media)
      .innerJoin(sites, eq(media.siteId, sites.id))
      .where(eq(media.moderationStatus, status))
      .orderBy(desc(media.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ count: sql<number>`count(*)` }).from(media).where(eq(media.moderationStatus, status)),
  ]);
  return c.json({ items, total: Number(countResult[0].count) });
});

adminRoutes.get("/media-review/:id/stream", async (c) => {
  const id = c.req.param("id");
  const [item] = await db.select({ stagingPath: media.stagingPath, moderationStatus: media.moderationStatus }).from(media).where(eq(media.id, id));
  if (!item) return c.json({ error: "Not found" }, 404);
  if (!item.stagingPath) {
    // Already approved/public — return the public storageUrl instead
    const [full] = await db.select({ storageUrl: media.storageUrl }).from(media).where(eq(media.id, id));
    return c.json({ url: full?.storageUrl ?? null });
  }
  const stg = getStagingStorageProvider();
  if (!stg) return c.json({ error: "Staging storage not configured" }, 503);
  try {
    // Existence check (plain metadata call, no signBlob) so we keep the helpful
    // 410 when the staging object is gone.
    await stg.getObjectSize(item.stagingPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("No such object")) {
      await db.update(media).set({ stagingPath: null }).where(eq(media.id, id));
      return c.json({ error: "File no longer available — it was deleted when blocked. Ask the user to re-upload." }, 410);
    }
    throw err;
  }
  // Stream the private staging object through the API via a short-lived token
  // (GCS signed URLs need signBlob, which is unreliable on Cloud Run). Build an
  // absolute URL from the forwarded host so the browser media tag can load it.
  const token = await signMediaStreamToken(id);
  const proto = c.req.header("x-forwarded-proto") ?? "https";
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? "";
  return c.json({ url: `${proto}://${host}/api/media-stream/${id}?t=${token}` });
});

adminRoutes.post("/media-review/:id/approve", async (c) => {
  const id = c.req.param("id");
  const [item] = await db.select().from(media).where(eq(media.id, id));
  if (!item) return c.json({ error: "Not found" }, 404);
  if (item.stagingPath) {
    const pub = getStorageProvider();
    const stg = getStagingStorageProvider();
    if (pub && stg) {
      const publicPath = item.stagingPath.replace(/^staging\//, "");
      try {
        await pub.copyFile(item.stagingPath, publicPath, process.env.GCS_STAGING_BUCKET_NAME);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("No such object")) {
          // Staging file was already deleted (e.g. auto-blocked then re-reviewed)
          await db.update(media).set({ moderationStatus: "approved", moderationSource: "manual", stagingPath: null }).where(eq(media.id, id));
          return c.json({ error: "Original file no longer available — the upload was deleted when it was blocked. Ask the user to re-upload." }, 422);
        }
        throw err;
      }
      const publicUrl = pub.getPublicUrl(publicPath);
      await db.update(media).set({ moderationStatus: "approved", moderationSource: "manual", stagingPath: null, storageUrl: publicUrl }).where(eq(media.id, id));
      return c.json({ ok: true });
    }
  }
  await db.update(media).set({ moderationStatus: "approved", moderationSource: "manual" }).where(eq(media.id, id));
  return c.json({ ok: true });
});

adminRoutes.post("/media-review/:id/block", async (c) => {
  const id = c.req.param("id");
  const { reason } = await c.req.json().catch(() => ({}));
  const [item] = await db.select().from(media).where(eq(media.id, id));
  if (!item) return c.json({ error: "Not found" }, 404);
  if (item.stagingPath) {
    const stg = getStagingStorageProvider();
    if (stg) await stg.delete(item.stagingPath).catch(() => {});
  }
  // If stagingPath is null, item was already approved/public — leave GCS file for grace-period cron
  await db.update(media).set({
    moderationStatus: "blocked",
    moderationSource: "manual",
    blockedAt: new Date(),
    stagingPath: null,
    ...(reason ? { moderationReason: reason } : {}),
  }).where(eq(media.id, id));
  return c.json({ ok: true });
});

adminRoutes.patch("/media-review/:id/status", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const { status, reason } = body as { status?: string; reason?: string };
  if (!status || !["review", "approved", "blocked"].includes(status)) {
    return c.json({ error: "status must be one of: review, approved, blocked" }, 400);
  }
  const [item] = await db.select().from(media).where(eq(media.id, id));
  if (!item) return c.json({ error: "Not found" }, 404);

  if (status === "review" && item.moderationSource === "auto" && !item.stagingPath) {
    return c.json({ error: "Cannot send to review — file was auto-blocked and the original upload was deleted" }, 422);
  }

  if (status === "approved") {
    if (item.stagingPath) {
      const pub = getStorageProvider();
      const stg = getStagingStorageProvider();
      if (pub && stg) {
        const publicPath = item.stagingPath.replace(/^staging\//, "");
        await pub.copyFile(item.stagingPath, publicPath, process.env.GCS_STAGING_BUCKET_NAME);
        const publicUrl = pub.getPublicUrl(publicPath);
        await db.update(media).set({ moderationStatus: "approved", moderationSource: "manual", moderationReason: null, blockedAt: null, stagingPath: null, storageUrl: publicUrl }).where(eq(media.id, id));
        const [updated] = await db.select({ id: media.id, moderationStatus: media.moderationStatus, moderationReason: media.moderationReason, moderationSource: media.moderationSource }).from(media).where(eq(media.id, id));
        return c.json({ ok: true, item: updated });
      }
    }
    await db.update(media).set({ moderationStatus: "approved", moderationSource: "manual", moderationReason: null, blockedAt: null }).where(eq(media.id, id));
  } else if (status === "blocked") {
    if (item.stagingPath) {
      const stg = getStagingStorageProvider();
      if (stg) await stg.delete(item.stagingPath).catch(() => {});
    }
    await db.update(media).set({
      moderationStatus: "blocked",
      moderationSource: "manual",
      blockedAt: new Date(),
      stagingPath: null,
      ...(reason ? { moderationReason: reason } : {}),
    }).where(eq(media.id, id));
  } else {
    // status === "review"
    await db.update(media).set({ moderationStatus: "review", moderationReason: null, moderationSource: null, blockedAt: null }).where(eq(media.id, id));
  }

  const [updated] = await db.select({ id: media.id, moderationStatus: media.moderationStatus, moderationReason: media.moderationReason, moderationSource: media.moderationSource }).from(media).where(eq(media.id, id));
  return c.json({ ok: true, item: updated });
});

adminRoutes.delete("/media-review/:id", async (c) => {
  const id = c.req.param("id");
  const [item] = await db.select().from(media).where(eq(media.id, id));
  if (!item) return c.json({ error: "Not found" }, 404);

  // Delete staging file if still in staging
  if (item.stagingPath) {
    const stg = getStagingStorageProvider();
    if (stg) await stg.delete(item.stagingPath).catch(() => {});
  }

  // Delete from public bucket if the storageUrl points to GCS
  const gcsDomain = "https://storage.googleapis.com/";
  if (item.storageUrl?.startsWith(gcsDomain)) {
    const pub = getStorageProvider();
    if (pub) {
      const afterDomain = item.storageUrl.slice(gcsDomain.length);
      const slashIdx = afterDomain.indexOf("/");
      if (slashIdx !== -1) {
        const publicPath = afterDomain.slice(slashIdx + 1);
        await pub.delete(publicPath).catch(() => {});
      }
    }
  }

  // Delete thumbnail from public bucket if present
  if (item.thumbnailUrl?.startsWith(gcsDomain)) {
    const pub = getStorageProvider();
    if (pub) {
      const afterDomain = item.thumbnailUrl.slice(gcsDomain.length);
      const slashIdx = afterDomain.indexOf("/");
      if (slashIdx !== -1) {
        const thumbPath = afterDomain.slice(slashIdx + 1);
        await pub.delete(thumbPath).catch(() => {});
      }
    }
  }

  await db.delete(media).where(eq(media.id, id));
  return c.json({ ok: true });
});

async function countSiteRows(siteId: string): Promise<Record<string, number>> {
  const [
    [{ value: contentCount }],
    [{ value: mediaCount }],
    [{ value: collectionsCount }],
    [{ value: navigationCount }],
    [{ value: scheduledTasksCount }],
    [{ value: aiHistoryCount }],
    [{ value: formSubmissionsCount }],
    [{ value: auditLogCount }],
    [{ value: siteMembersCount }],
    [{ value: subscriptionsCount }],
    [{ value: partnerSitesCount }],
    [{ value: referralsCount }],
  ] = await Promise.all([
    db.select({ value: count() }).from(content).where(eq(content.siteId, siteId)),
    db.select({ value: count() }).from(media).where(eq(media.siteId, siteId)),
    db.select({ value: count() }).from(collections).where(eq(collections.siteId, siteId)),
    db.select({ value: count() }).from(navigation).where(eq(navigation.siteId, siteId)),
    db.select({ value: count() }).from(scheduledTasks).where(eq(scheduledTasks.siteId, siteId)),
    db.select({ value: count() }).from(aiHistory).where(eq(aiHistory.siteId, siteId)),
    db.select({ value: count() }).from(formSubmissions).where(eq(formSubmissions.siteId, siteId)),
    db.select({ value: count() }).from(auditLog).where(eq(auditLog.siteId, siteId)),
    db.select({ value: count() }).from(siteMembers).where(eq(siteMembers.siteId, siteId)),
    db.select({ value: count() }).from(subscriptions).where(eq(subscriptions.siteId, siteId)),
    db.select({ value: count() }).from(partnerSites).where(eq(partnerSites.siteId, siteId)),
    db.select({ value: count() }).from(referrals).where(eq(referrals.referredSiteId, siteId)),
  ]);

  return {
    content: contentCount,
    media: mediaCount,
    collections: collectionsCount,
    navigation: navigationCount,
    scheduledTasks: scheduledTasksCount,
    aiHistory: aiHistoryCount,
    formSubmissions: formSubmissionsCount,
    auditLog: auditLogCount,
    siteMembers: siteMembersCount,
    subscriptions: subscriptionsCount,
    partnerSites: partnerSitesCount,
    referrals: referralsCount,
  };
}

export async function hardDeleteSite(siteId: string): Promise<void> {
  // Collect media storage paths BEFORE deleting rows, then best-effort delete files.
  const storage = getStorageProvider();
  const mediaRows = await db.select({ storageUrl: media.storageUrl, variants: media.variants })
    .from(media)
    .where(eq(media.siteId, siteId));

  // Delete DB rows in FK-safe order. Child tables that cascade via their parent
  // (contentBlocks, contentVersions, contentMedia, contentCollections) are
  // handled when we delete `content`.
  await db.delete(paymentMethods).where(
    sql`${paymentMethods.subscriptionId} IN (SELECT id FROM ${subscriptions} WHERE site_id = ${siteId})`,
  );
  await db.delete(subscriptions).where(eq(subscriptions.siteId, siteId));
  await db.delete(partnerSites).where(eq(partnerSites.siteId, siteId));
  await db.delete(referrals).where(eq(referrals.referredSiteId, siteId));
  await db.delete(content).where(eq(content.siteId, siteId));
  await db.delete(media).where(eq(media.siteId, siteId));
  await db.delete(collections).where(eq(collections.siteId, siteId));
  await db.delete(navigation).where(eq(navigation.siteId, siteId));
  await db.delete(scheduledTasks).where(eq(scheduledTasks.siteId, siteId));
  await db.delete(aiHistory).where(eq(aiHistory.siteId, siteId));
  await db.delete(formSubmissions).where(eq(formSubmissions.siteId, siteId));
  await db.delete(auditLog).where(eq(auditLog.siteId, siteId));
  // Users whose DEFAULT (users.site_id) is this site need their pointer moved
  // before the site row goes away. Capture them first.
  const defaultedUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.siteId, siteId));

  await db.delete(siteMembers).where(eq(siteMembers.siteId, siteId));

  // Re-point each affected user's default to a surviving active membership;
  // only null it when they have no other site left (truly orphaned). We keep
  // the user row either way — an orphaned account stays recoverable (signing up
  // again with the same email reclaims it; see auth.ts /signup).
  for (const u of defaultedUsers) {
    const [survivor] = await db
      .select({ siteId: siteMembers.siteId })
      .from(siteMembers)
      .where(and(eq(siteMembers.userId, u.id), eq(siteMembers.status, "active")))
      .limit(1);
    await db.update(users).set({ siteId: survivor?.siteId ?? null }).where(eq(users.id, u.id));
  }

  await db.delete(sites).where(eq(sites.id, siteId));

  // Best-effort storage cleanup — site rows are already gone, so errors here
  // leave orphaned blobs but don't break the logical deletion.
  if (storage) {
    for (const row of mediaRows) {
      const paths = new Set<string>();
      if (row.storageUrl) paths.add(row.storageUrl);
      const variants = (row.variants || {}) as Record<string, unknown>;
      for (const v of Object.values(variants)) {
        if (typeof v === "string") paths.add(v);
      }
      for (const path of paths) {
        try {
          await storage.delete(path);
        } catch (err) {
          console.error(`Failed to delete storage object ${path}:`, err);
        }
      }
    }
  }
}

// ── GET /partners — list all partners ───────────────────────────────────────

adminRoutes.get("/partners", async (c) => {
  const rows = await db
    .select({
      id: partners.id,
      name: partners.name,
      code: partners.code,
      commissionRate: partners.commissionRate,
      commissionsOnAddons: partners.commissionsOnAddons,
      isAgency: partners.isAgency,
      status: partners.status,
      createdAt: partners.createdAt,
      userId: partners.userId,
      userEmail: users.email,
      userFirstName: users.firstName,
      userLastName: users.lastName,
    })
    .from(partners)
    .innerJoin(users, eq(partners.userId, users.id))
    .orderBy(desc(partners.createdAt));

  // Get site counts per partner (partnerSites = sites the partner is billing
  // party for) and referral counts (pure referral attribution) — together they
  // show whether a partner is an agency, a referrer, or both.
  const [siteCounts, referralCounts] = await Promise.all([
    db
      .select({
        partnerId: partnerSites.partnerId,
        count: count(),
      })
      .from(partnerSites)
      .groupBy(partnerSites.partnerId),
    db
      .select({
        referrerUserId: referrals.referrerUserId,
        count: count(),
      })
      .from(referrals)
      .groupBy(referrals.referrerUserId),
  ]);

  const countMap = new Map(siteCounts.map((r) => [r.partnerId, r.count]));
  const referralCountMap = new Map(referralCounts.map((r) => [r.referrerUserId, r.count]));

  const items = rows.map((r) => ({
    id: r.id,
    name: r.name,
    code: r.code,
    commissionRate: r.commissionRate,
    commissionsOnAddons: r.commissionsOnAddons,
    isAgency: r.isAgency,
    status: r.status,
    createdAt: r.createdAt,
    userId: r.userId,
    userEmail: r.userEmail,
    userName: `${r.userFirstName || ""} ${r.userLastName || ""}`.trim() || r.userEmail,
    siteCount: countMap.get(r.id) || 0,
    referralCount: referralCountMap.get(r.userId) || 0,
  }));

  return c.json({ items });
});

// Same helper as public.ts/sites.ts — email bodies interpolate user-supplied
// strings (partner name, email).
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── POST /partners — create partner ─────────────────────────────────────────

adminRoutes.post("/partners", async (c) => {
  const body = await c.req.json<{
    email?: string;
    userId?: string;
    name: string;
    code: string;
    commissionRate?: string;
    commissionsOnAddons?: boolean;
    isAgency?: boolean;
  }>();

  if ((!body.email && !body.userId) || !body.name || !body.code) {
    return c.json({ error: "email (or userId), name, and code are required" }, 400);
  }

  // Resolve user: prefer userId, else upsert by email (stub account if new)
  let userId: string;
  if (body.userId) {
    const [existing] = await db.select().from(users).where(eq(users.id, body.userId));
    if (!existing) return c.json({ error: "User not found" }, 404);
    userId = existing.id;
  } else {
    const email = body.email!.trim().toLowerCase();
    const [existing] = await db.select().from(users).where(eq(users.email, email));
    if (existing) {
      userId = existing.id;
    } else {
      // Stub account — partner can sign up later using this email (password gets set via reset flow)
      const [created] = await db.insert(users).values({ email }).returning({ id: users.id });
      userId = created.id;
    }
  }

  const [partner] = await db
    .insert(partners)
    .values({
      userId,
      name: body.name,
      code: body.code.toUpperCase(),
      commissionRate: body.commissionRate || null,
      commissionsOnAddons: body.commissionsOnAddons === true,
      isAgency: body.isAgency === true,
      status: "active",
    })
    .returning();

  await db.update(users).set({ globalRole: "partner" }).where(eq(users.id, userId));

  // Invite email. Signup deliberately refuses partner-role accounts (reclaim
  // would let anyone hijack a partner by knowing the email), so a stub with no
  // password activates via the reset-token flow — send that link proactively
  // instead of making the partner discover "Forgot password" on their own.
  // Fire-and-forget: an email failure must not fail partner creation.
  void (async () => {
    const emailProvider = getEmailProvider();
    if (!emailProvider) return;
    const [partnerUser] = await db.select().from(users).where(eq(users.id, userId));
    if (!partnerUser) return;

    const baseDomain = process.env.BASE_DOMAIN || "cadmus.digital";
    const referralLink = `https://${baseDomain}/admin/signup?ref=${encodeURIComponent(partner.code)}`;
    const clientLinkHtml = partner.isAgency
      ? `<p>As an agency partner you also have a <strong>client invite link</strong> — clients who sign up through it get you added as a site admin so you can manage the site and its billing:</p><p><a href="https://${baseDomain}/admin/signup?client=${encodeURIComponent(partner.code)}">https://${baseDomain}/admin/signup?client=${encodeURIComponent(partner.code)}</a></p>`
      : "";

    let actionHtml: string;
    if (partnerUser.passwordHash) {
      actionHtml = `<p>Your existing Cadmus login (${escapeHtml(partnerUser.email)}) now has partner access.</p>`;
    } else {
      // Invite tokens get a longer window than the 1-hour forgot-password
      // flow — the recipient isn't sitting at the reset form waiting.
      const inviteToken = crypto.randomBytes(32).toString("hex");
      await db
        .update(users)
        .set({ resetToken: hashToken(inviteToken), resetTokenExpiry: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) })
        .where(eq(users.id, userId));
      const setPasswordUrl = `https://${baseDomain}/admin/reset-password?token=${inviteToken}`;
      actionHtml = `<p><a href="${setPasswordUrl}" style="display:inline-block;padding:10px 18px;background:#111;color:#fff;border-radius:6px;text-decoration:none">Set your password</a></p><p style="color:#888;font-size:12px">This link expires in 7 days. If it expires, use "Forgot password" on the login page with this email address.</p>`;
    }

    await emailProvider.send({
      to: partnerUser.email,
      from: "Cadmus <noreply@cadmus.digital>",
      subject: "You're a Cadmus partner",
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:2rem">
          <h2>Welcome to the Cadmus partner program</h2>
          <p><strong>${escapeHtml(partner.name)}</strong> is set up with partner code <code>${escapeHtml(partner.code)}</code>.</p>
          <p>Share your referral link — anyone who signs up through it is attributed to you:</p>
          <p><a href="${referralLink}">${referralLink}</a></p>
          ${clientLinkHtml}
          ${actionHtml}
        </div>
      `,
    });
  })().catch((err) => logError(`[partners] invite email failed for partner ${partner.id}`, err));

  return c.json(partner, 201);
});

// ── PATCH /partners/:id/sites/:siteId — toggle billing-party flag ────────────
// Staff-side confirmation for agency client sites: records whether the partner
// is actually the billing party once payment is arranged (the partner pays
// through the site's normal upgrade flow as an admin member).

adminRoutes.patch("/partners/:id/sites/:siteId", async (c) => {
  const actor = c.get("user");
  const partnerId = c.req.param("id");
  const siteId = c.req.param("siteId");
  const body = await c.req.json<{ billingActive?: boolean }>();
  if (typeof body.billingActive !== "boolean") {
    return c.json({ error: "billingActive (boolean) is required" }, 400);
  }

  const [link] = await db
    .update(partnerSites)
    .set({ billingActive: body.billingActive })
    .where(and(eq(partnerSites.partnerId, partnerId), eq(partnerSites.siteId, siteId)))
    .returning();
  if (!link) return c.json({ error: "Partner-site link not found" }, 404);

  await db.insert(auditLog).values({
    siteId,
    actorType: "user",
    actorId: actor.id,
    action: body.billingActive ? "partner.billing_activated" : "partner.billing_deactivated",
    entityType: "site",
    entityId: siteId,
    details: { partnerId },
  });

  return c.json({ ok: true, billingActive: link.billingActive });
});

// ── PUT /partners/:id — update partner ──────────────────────────────────────

adminRoutes.put("/partners/:id", async (c) => {
  const partnerId = c.req.param("id");
  const body = await c.req.json<{
    name?: string;
    code?: string;
    commissionRate?: string;
    commissionsOnAddons?: boolean;
    isAgency?: boolean;
    status?: string;
  }>();

  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.code !== undefined) updates.code = body.code.toUpperCase();
  if (body.commissionRate !== undefined) updates.commissionRate = body.commissionRate;
  if (body.commissionsOnAddons !== undefined) updates.commissionsOnAddons = body.commissionsOnAddons === true;
  if (body.isAgency !== undefined) updates.isAgency = body.isAgency === true;
  if (body.status !== undefined) updates.status = body.status;

  if (Object.keys(updates).length === 0) {
    return c.json({ error: "No fields to update" }, 400);
  }

  const [updated] = await db
    .update(partners)
    .set(updates)
    .where(eq(partners.id, partnerId))
    .returning();

  if (!updated) {
    return c.json({ error: "Partner not found" }, 404);
  }

  return c.json(updated);
});

// ── GET /partners/:id — partner detail ──────────────────────────────────────

adminRoutes.get("/partners/:id", async (c) => {
  const partnerId = c.req.param("id");

  const [partner] = await db
    .select({
      id: partners.id,
      name: partners.name,
      code: partners.code,
      commissionRate: partners.commissionRate,
      status: partners.status,
      commissionsOnAddons: partners.commissionsOnAddons,
      isAgency: partners.isAgency,
      createdAt: partners.createdAt,
      userId: partners.userId,
      userEmail: users.email,
      userFirstName: users.firstName,
      userLastName: users.lastName,
    })
    .from(partners)
    .innerJoin(users, eq(partners.userId, users.id))
    .where(eq(partners.id, partnerId));

  if (!partner) {
    return c.json({ error: "Partner not found" }, 404);
  }

  const linkedSites = await db
    .select({
      id: sites.id,
      name: sites.name,
      subdomain: sites.subdomain,
      status: sites.status,
      billingActive: partnerSites.billingActive,
      linkedAt: partnerSites.createdAt,
    })
    .from(partnerSites)
    .innerJoin(sites, eq(partnerSites.siteId, sites.id))
    .where(eq(partnerSites.partnerId, partnerId));

  return c.json({
    partner: {
      id: partner.id,
      name: partner.name,
      code: partner.code,
      commissionRate: partner.commissionRate,
      commissionsOnAddons: partner.commissionsOnAddons,
      isAgency: partner.isAgency,
      status: partner.status,
      createdAt: partner.createdAt,
    },
    user: {
      id: partner.userId,
      email: partner.userEmail,
      name: `${partner.userFirstName || ""} ${partner.userLastName || ""}`.trim() || partner.userEmail,
    },
    linkedSites,
  });
});

// ── GET /referrals — list all referrals ─────────────────────────────────────

// A qualified referral only becomes payable after the clawback window — long
// enough for a signup-refund cycle (or an immediate cancel) to surface before
// any commission goes out.
const REFERRAL_CLAWBACK_DAYS = 45;

function rewardEligibleAt(qualifiedAt: Date | null): Date | null {
  if (!qualifiedAt) return null;
  return new Date(qualifiedAt.getTime() + REFERRAL_CLAWBACK_DAYS * 86_400_000);
}

adminRoutes.get("/referrals", async (c) => {
  const statusFilter = c.req.query("status") || "";

  const where = statusFilter ? eq(referrals.status, statusFilter) : undefined;

  const rows = await db
    .select({
      id: referrals.id,
      referralCode: referrals.referralCode,
      status: referrals.status,
      qualifiedAt: referrals.qualifiedAt,
      rewardedAt: referrals.rewardedAt,
      createdAt: referrals.createdAt,
      referrerEmail: users.email,
      referrerFirstName: users.firstName,
      referrerLastName: users.lastName,
      siteName: sites.name,
      siteSubdomain: sites.subdomain,
      siteId: sites.id,
      sitePlan: sites.plan,
      // Partner referrals match on code; personal ref-xxxx codes leave these null
      partnerName: partners.name,
      partnerCommissionRate: partners.commissionRate,
      partnerCommissionsOnAddons: partners.commissionsOnAddons,
    })
    .from(referrals)
    .innerJoin(users, eq(referrals.referrerUserId, users.id))
    .innerJoin(sites, eq(referrals.referredSiteId, sites.id))
    .leftJoin(partners, eq(partners.code, referrals.referralCode))
    .where(where)
    .orderBy(desc(referrals.createdAt));

  const items = rows.map((r) => ({
    id: r.id,
    referralCode: r.referralCode,
    status: r.status,
    qualifiedAt: r.qualifiedAt,
    rewardedAt: r.rewardedAt,
    createdAt: r.createdAt,
    referrerEmail: r.referrerEmail,
    referrerName: `${r.referrerFirstName || ""} ${r.referrerLastName || ""}`.trim() || r.referrerEmail,
    siteName: r.siteName,
    siteSubdomain: r.siteSubdomain,
    siteId: r.siteId,
    sitePlan: r.sitePlan,
    partnerName: r.partnerName,
    commissionRate: r.partnerCommissionRate,
    commissionsOnAddons: r.partnerCommissionsOnAddons ?? false,
    rewardEligibleAt: rewardEligibleAt(r.qualifiedAt),
  }));

  return c.json({ items });
});

// ── POST /referrals/:id/reward — mark a qualified referral as paid out ──────

adminRoutes.post("/referrals/:id/reward", async (c) => {
  const actor = c.get("user");
  const referralId = c.req.param("id");

  const [referral] = await db.select().from(referrals).where(eq(referrals.id, referralId));
  if (!referral) return c.json({ error: "Referral not found" }, 404);
  if (referral.status !== "qualified") {
    return c.json({ error: `Only qualified referrals can be rewarded (current status: ${referral.status})` }, 400);
  }

  const eligibleAt = rewardEligibleAt(referral.qualifiedAt);
  if (!eligibleAt || eligibleAt > new Date()) {
    return c.json(
      {
        error: `Referral is inside the ${REFERRAL_CLAWBACK_DAYS}-day clawback window — eligible ${
          eligibleAt ? eligibleAt.toISOString().slice(0, 10) : "once qualified"
        }`,
      },
      400
    );
  }

  const rewardedAt = new Date();
  await db
    .update(referrals)
    .set({ status: "rewarded", rewardedAt })
    .where(eq(referrals.id, referralId));

  // Snapshot the commission terms in effect at payout time — the partner row
  // holds only the CURRENT rate, so this audit entry is the historical record
  // of what this payout was computed against.
  const [partner] = await db
    .select({ commissionRate: partners.commissionRate, commissionsOnAddons: partners.commissionsOnAddons })
    .from(partners)
    .where(eq(partners.code, referral.referralCode));

  await db.insert(auditLog).values({
    siteId: referral.referredSiteId,
    actorType: "user",
    actorId: actor.id,
    action: "referral.rewarded",
    entityType: "referral",
    entityId: referralId,
    details: {
      referralCode: referral.referralCode,
      referrerUserId: referral.referrerUserId,
      commissionRate: partner?.commissionRate ?? null,
      commissionsOnAddons: partner?.commissionsOnAddons ?? false,
    },
  });

  return c.json({ ok: true, rewardedAt });
});

// ── GET /users — paginated user list ────────────────────────────────────────

adminRoutes.get("/users", async (c) => {
  const page = Math.max(1, Number(c.req.query("page")) || 1);
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 25));
  const search = c.req.query("search")?.trim() || "";
  const offset = (page - 1) * limit;

  const where = search
    ? or(
        like(users.email, `%${search}%`),
        like(users.firstName, `%${search}%`),
        like(users.lastName, `%${search}%`),
      )
    : undefined;

  const [items, [{ value: total }]] = await Promise.all([
    db
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        globalRole: users.globalRole,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(where)
      .orderBy(desc(users.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ value: count() }).from(users).where(where),
  ]);

  return c.json({
    items,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
});

// ── Promotions CRUD ───────────────────────────────────────────────────────────

adminRoutes.get("/promotions", async (c) => {
  const items = await db
    .select()
    .from(promotions)
    .orderBy(desc(promotions.createdAt));
  return c.json({ items });
});

adminRoutes.post("/promotions", async (c) => {
  const body = await c.req.json<{
    code: string;
    slug?: string;
    name: string;
    type?: string;
    planOverride?: string;
    trialDays?: number;
    maxRedemptions?: number | null;
    expiresAt?: string | null;
    isActive?: boolean;
    notes?: string;
  }>();

  if (!body.code || !body.name) {
    return c.json({ error: "code and name are required" }, 400);
  }

  const [item] = await db
    .insert(promotions)
    .values({
      code: body.code.toLowerCase().trim(),
      slug: body.slug?.toLowerCase().trim() || null,
      name: body.name.trim(),
      type: body.type || "free_trial",
      planOverride: body.planOverride || "monthly",
      trialDays: body.trialDays ?? 30,
      maxRedemptions: body.maxRedemptions ?? null,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      isActive: body.isActive ?? true,
      notes: body.notes || null,
    })
    .returning();

  return c.json({ item }, 201);
});

adminRoutes.get("/promotions/:id", async (c) => {
  const id = c.req.param("id");
  const [item] = await db.select().from(promotions).where(eq(promotions.id, id));
  if (!item) return c.json({ error: "Not found" }, 404);
  return c.json({ item });
});

adminRoutes.put("/promotions/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{
    code?: string;
    slug?: string | null;
    name?: string;
    type?: string;
    planOverride?: string;
    trialDays?: number;
    maxRedemptions?: number | null;
    expiresAt?: string | null;
    isActive?: boolean;
    notes?: string | null;
  }>();

  const [item] = await db
    .update(promotions)
    .set({
      ...(body.code !== undefined && { code: body.code.toLowerCase().trim() }),
      ...(body.slug !== undefined && { slug: body.slug ? body.slug.toLowerCase().trim() : null }),
      ...(body.name !== undefined && { name: body.name.trim() }),
      ...(body.type !== undefined && { type: body.type }),
      ...(body.planOverride !== undefined && { planOverride: body.planOverride }),
      ...(body.trialDays !== undefined && { trialDays: body.trialDays }),
      ...(body.maxRedemptions !== undefined && { maxRedemptions: body.maxRedemptions }),
      ...(body.expiresAt !== undefined && { expiresAt: body.expiresAt ? new Date(body.expiresAt) : null }),
      ...(body.isActive !== undefined && { isActive: body.isActive }),
      ...(body.notes !== undefined && { notes: body.notes }),
      updatedAt: new Date(),
    })
    .where(eq(promotions.id, id))
    .returning();

  if (!item) return c.json({ error: "Not found" }, 404);
  return c.json({ item });
});

adminRoutes.delete("/promotions/:id", async (c) => {
  const id = c.req.param("id");
  await db.delete(promotions).where(eq(promotions.id, id));
  return c.json({ ok: true });
});

adminRoutes.get("/promotions/:id/redemptions", async (c) => {
  const id = c.req.param("id");
  const items = await db
    .select({
      id: promoRedemptions.id,
      siteId: promoRedemptions.siteId,
      siteName: sites.name,
      subdomain: sites.subdomain,
      userId: promoRedemptions.userId,
      userEmail: users.email,
      redeemedAt: promoRedemptions.redeemedAt,
      ipAddress: promoRedemptions.ipAddress,
    })
    .from(promoRedemptions)
    .innerJoin(sites, eq(promoRedemptions.siteId, sites.id))
    .innerJoin(users, eq(promoRedemptions.userId, users.id))
    .where(eq(promoRedemptions.promoId, id))
    .orderBy(desc(promoRedemptions.redeemedAt));

  return c.json({ items });
});

// ── POST /maintenance/expire-promos — downgrade sites past their promo period ─

adminRoutes.post("/maintenance/expire-promos", async (c) => {
  const now = new Date();
  const dryRun = c.req.query("dryRun") === "true";

  const expired = await db
    .select({ id: sites.id, name: sites.name, subdomain: sites.subdomain, promoEndsAt: sites.promoEndsAt, promoCode: sites.promoCode })
    .from(sites)
    .where(and(isNotNull(sites.promoEndsAt), lt(sites.promoEndsAt, now)));

  if (dryRun) {
    return c.json({ dryRun: true, expired: expired.length, previews: expired });
  }

  for (const site of expired) {
    await db
      .update(sites)
      .set({ plan: "free", promoEndsAt: null, updatedAt: now })
      .where(eq(sites.id, site.id));
  }

  return c.json({ expired: expired.length, results: expired.map((s) => ({ siteId: s.id, name: s.name })) });
});
