import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { eq, and, ne, count, desc, sql, inArray } from "drizzle-orm";
import { db, sites, users, auditLog, content, contentBlocks, contentVersions, collections, contentCollections, media, contentMedia, navigation, formSubmissions, aiHistory, siteMembers, subscriptions, paymentMethods, partners, partnerSites, referrals } from "@cadmus/db";
import { randomBytes } from "crypto";
import { signToken, requireRole, getActiveMembershipRole } from "../middleware/auth.js";
import type { SiteRole } from "@cadmus/shared";
import { checkFeatureGate, isCompedSite } from "../lib/feature-gates.js";
import { recompileSiteCss } from "../lib/theme-recompile.js";
import { hashPassword, meetsPasswordRequirements } from "../lib/password.js";
import { getEmailProvider } from "../lib/email.js";
import { createRateLimiter, getClientIp } from "../lib/rate-limit.js";
import { getAdminUrl, getSiteUrl, getSiteHost } from "../lib/urls.js";
import { archiveContentForRestart } from "../lib/onboarding-archive.js";
import { sanitizeHtmlBlock } from "../lib/sanitize-html-block.js";
import { mergeDesignIntent } from "../lib/design-intent.js";
import { buildLlmsTxt, canonicalOrigin, type LlmsContentItem } from "../lib/llms-txt.js";
import { ensureTurnstileProvisioned, deprovisionTurnstileForDomain } from "../lib/turnstile-provision.js";
import { getAIRouter } from "./ai.js";
import type { AuthUser, DesignIntent, SiteBrief } from "@cadmus/shared";
import type { CustomHostnameProvider } from "@cadmus/cloud";

// Signup rate limit: 5 new accounts per IP per hour
const signupLimiter = createRateLimiter("sites.provision", 5, 60 * 60_000);

let customHostnames: CustomHostnameProvider | null = null;
export function setCustomHostnameProvider(p: CustomHostnameProvider) {
  customHostnames = p;
}

export const sitesRoutes = new Hono();

const SITE_ROLE_RANK: Record<string, number> = { owner: 4, admin: 3, editor: 2, viewer: 1 };

/**
 * Authorizes the authenticated user against a site id taken from the URL/body.
 * The requireSiteMembership middleware only governs the x-site-id/hostname-
 * resolved tenant; routes keyed on `:id` (which can be ANY site id) must verify
 * membership against THAT id themselves, or an owner of site X could read/mutate
 * site Y by passing Y's id in the path. Throws 403 if the user is not an active
 * member of `siteId` (or lacks `minRole`); cadmus_admin bypasses. Returns 403
 * (not 404) for unknown sites to avoid leaking which site ids exist.
 */
async function assertSiteAccess(c: Context, siteId: string, minRole: SiteRole = "viewer"): Promise<SiteRole> {
  const user = c.get("user") as AuthUser | undefined;
  if (!user) throw new HTTPException(401, { message: "Authentication required" });
  if (user.globalRole === "cadmus_admin") return "admin";
  const role = await getActiveMembershipRole(user.id, siteId);
  if (!role) throw new HTTPException(403, { message: "You do not have access to this site" });
  if (SITE_ROLE_RANK[role] < SITE_ROLE_RANK[minRole]) {
    throw new HTTPException(403, { message: "Insufficient permissions" });
  }
  return role;
}

function generateSubdomain(): string {
  const id = randomBytes(6).toString("base64url").toLowerCase().slice(0, 8);
  return `site-${id}`;
}

// Resolve hostname → siteId (used by web frontend for multi-tenant routing)
sitesRoutes.get("/resolve", async (c) => {
  const hostname = c.req.query("hostname");
  if (!hostname) {
    return c.json({ error: "hostname query parameter is required" }, 400);
  }

  const baseDomain = process.env.BASE_DOMAIN || "cadmus.digital";
  let site: typeof sites.$inferSelect | undefined;

  if (hostname.endsWith(`.${baseDomain}`)) {
    // Subdomain lookup: site-abc123.cadmus.digital → subdomain "site-abc123"
    const subdomain = hostname.replace(`.${baseDomain}`, "");
    const [found] = await db
      .select()
      .from(sites)
      .where(eq(sites.subdomain, subdomain));
    site = found;
  } else {
    // Custom domain lookup (includes cadmus.digital itself if configured as a site domain)
    const [found] = await db
      .select()
      .from(sites)
      .where(eq(sites.domain, hostname));
    site = found;
  }

  if (!site) {
    return c.json({ error: "Site not found" }, 404);
  }

  // The platform apex (BASE_DOMAIN) can be a site's custom domain, but it's
  // served directly rather than provisioned as a Cloudflare custom hostname, so
  // its status never flips to "active" through that path. Treat it as active so
  // canonical-host redirects and the admin "View site" link work for it.
  const domainStatus =
    site.domain && site.domain === baseDomain ? "active" : site.domainStatus;

  return c.json({
    siteId: site.id,
    name: site.name,
    subdomain: site.subdomain,
    domain: site.domain,
    domainStatus,
    status: site.status,
  });
});

// Get site by ID
sitesRoutes.get("/:id", async (c) => {
  const id = c.req.param("id");
  await assertSiteAccess(c, id);

  const [site] = await db.select().from(sites).where(eq(sites.id, id));
  if (!site) {
    return c.json({ error: "Site not found" }, 404);
  }

  return c.json(site);
});

// Get site stats (dashboard)
sitesRoutes.get("/:id/stats", async (c) => {
  const id = c.req.param("id");
  await assertSiteAccess(c, id);

  const [existing] = await db.select().from(sites).where(eq(sites.id, id));
  if (!existing) {
    return c.json({ error: "Site not found" }, 404);
  }

  const [contentCounts] = await db
    .select({
      pages: count(sql`CASE WHEN ${content.type} = 'page' THEN 1 END`),
      posts: count(sql`CASE WHEN ${content.type} = 'post' THEN 1 END`),
      published: count(sql`CASE WHEN ${content.status} = 'published' THEN 1 END`),
      drafts: count(sql`CASE WHEN ${content.status} = 'draft' THEN 1 END`),
    })
    .from(content)
    .where(eq(content.siteId, id));

  const [mediaCount] = await db
    .select({ total: count() })
    .from(media)
    .where(eq(media.siteId, id));

  const activity = await db
    .select({
      action: auditLog.action,
      entityType: auditLog.entityType,
      createdAt: auditLog.createdAt,
      details: auditLog.details,
    })
    .from(auditLog)
    .where(eq(auditLog.siteId, id))
    .orderBy(desc(auditLog.createdAt))
    .limit(10);

  return c.json({
    content: contentCounts,
    media: mediaCount.total,
    activity,
  });
});

// Get audit log (paginated, filterable)
sitesRoutes.get("/:id/audit-log", async (c) => {
  const id = c.req.param("id");
  await assertSiteAccess(c, id, "admin");
  const page = Math.max(1, parseInt(c.req.query("page") || "1"));
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") || "50")));
  const offset = (page - 1) * limit;

  const actorType = c.req.query("actorType");
  const action = c.req.query("action");
  const entityType = c.req.query("entityType");

  const conditions = [eq(auditLog.siteId, id)];
  if (actorType) conditions.push(eq(auditLog.actorType, actorType));
  if (action) conditions.push(eq(auditLog.action, action));
  if (entityType) conditions.push(eq(auditLog.entityType, entityType));

  const where = conditions.length === 1 ? conditions[0] : and(...conditions);

  const [{ total }] = await db.select({ total: count() }).from(auditLog).where(where);

  const entries = await db
    .select({
      id: auditLog.id,
      actorType: auditLog.actorType,
      actorId: auditLog.actorId,
      action: auditLog.action,
      entityType: auditLog.entityType,
      entityId: auditLog.entityId,
      details: auditLog.details,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .where(where)
    .orderBy(desc(auditLog.createdAt))
    .limit(limit)
    .offset(offset);

  // Resolve actor names for user actors
  const actorIds = [...new Set(entries.filter((e) => e.actorType === "user" && e.actorId).map((e) => e.actorId!))];
  const actorMap: Record<string, string> = {};
  if (actorIds.length > 0) {
    const actorUsers = await db
      .select({ id: users.id, email: users.email, firstName: users.firstName, lastName: users.lastName })
      .from(users)
      .where(inArray(users.id, actorIds));
    for (const u of actorUsers) {
      const name = [u.firstName, u.lastName].filter(Boolean).join(" ");
      actorMap[u.id] = name || u.email;
    }
  }

  const enriched = entries.map((e) => ({
    ...e,
    actorName: e.actorType === "user" && e.actorId ? actorMap[e.actorId] || e.actorId : e.actorType === "ai" ? "AI" : e.actorType,
  }));

  return c.json({
    entries: enriched,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
});

// Provision a new site (signup flow)
sitesRoutes.post("/", async (c) => {
  const ip = getClientIp({
    "x-forwarded-for": c.req.header("x-forwarded-for"),
    "x-real-ip": c.req.header("x-real-ip"),
  });
  if (!signupLimiter.check(ip)) {
    return c.json({ error: "Too many signup attempts. Please try again later." }, 429);
  }

  const body = await c.req.json();
  const { name, ownerEmail, password, partnerCode, referralCode: refCode, plan } = body;

  if (!name || !ownerEmail) {
    return c.json({ error: "name and ownerEmail are required" }, 400);
  }

  if (password && !meetsPasswordRequirements(password)) {
    return c.json({ error: "Password must be at least 12 characters and include an uppercase letter and a number or symbol" }, 400);
  }

  const billingPlan: "monthly" | "annual" = plan === "annual" ? "annual" : "monthly";

  // Validate partner code if provided
  let partner: typeof partners.$inferSelect | undefined;
  if (partnerCode) {
    const [found] = await db
      .select()
      .from(partners)
      .where(eq(partners.code, partnerCode));
    if (!found || found.status !== "active") {
      return c.json({ error: "Invalid partner code" }, 400);
    }
    partner = found;
  }

  // Look up referrer if a referral code was provided
  let referrerUser: typeof users.$inferSelect | undefined;
  if (refCode) {
    const [found] = await db
      .select()
      .from(users)
      .where(eq(users.referralCode, refCode));
    if (found) {
      referrerUser = found;
    }
    // Invalid referral codes are silently ignored — don't block signup
  }

  // Reject signup if the email is already registered — the user should log in instead.
  const [existingUser] = await db.select({ id: users.id }).from(users).where(eq(users.email, ownerEmail));
  if (existingUser) {
    return c.json({ error: "An account with this email already exists. Please log in instead." }, 409);
  }

  const subdomain = generateSubdomain();
  const passwordHash = password ? hashPassword(password) : undefined;

  const { site: newSite, owner } = await db.transaction(async (tx) => {
    const [s] = await tx
      .insert(sites)
      .values({
        name,
        subdomain,
        status: "onboarding",
        settings: {
          billingPlan,
          formDefaults: { notificationEmail: ownerEmail },
        },
      })
      .returning();

    const userReferralCode = `ref-${randomBytes(4).toString("hex")}`;
    const [o] = await tx
      .insert(users)
      .values({
        siteId: s.id,
        email: ownerEmail,
        role: "owner",
        referralCode: userReferralCode,
        ...(passwordHash ? { passwordHash } : {}),
      })
      .returning();

    // Create site_members entry
    await tx.insert(siteMembers).values({
      siteId: s.id,
      userId: o.id,
      role: "owner",
      joinedAt: new Date(),
      status: "active",
    });

    await tx.insert(auditLog).values({
      siteId: s.id,
      actorType: "user",
      actorId: o.id,
      action: "site.provisioned",
      entityType: "site",
      entityId: s.id,
      details: { subdomain, ownerEmail, partnerCode: partnerCode || undefined },
    });

    // Link partner if a valid partner code was provided
    if (partner) {
      await tx.insert(partnerSites).values({
        partnerId: partner.id,
        siteId: s.id,
      });
    }

    // Track referral if a valid referral code was used
    if (referrerUser) {
      await tx.insert(referrals).values({
        referrerUserId: referrerUser.id,
        referredSiteId: s.id,
        referralCode: refCode!,
        status: "pending",
      });
    }

    return { site: s, owner: o };
  });

  const adminUrl = getAdminUrl();
  const siteUrl = getSiteUrl(subdomain);
  const siteHost = getSiteHost(subdomain);

  const result: Record<string, unknown> = {
    site: newSite,
    owner,
    adminUrl,
  };

  // If a password was provided, return a JWT so the user is logged in immediately
  if (password) {
    const authUser: AuthUser = {
      id: owner.id,
      email: owner.email,
      role: "owner",
      siteId: newSite.id,
    };
    result.token = await signToken(authUser);
    result.user = authUser;
  }

  // Fire-and-forget: welcome email
  const emailProvider = getEmailProvider();
  if (emailProvider) {
    emailProvider.send({
      to: ownerEmail,
      from: `Cadmus <noreply@${process.env.MAILGUN_DOMAIN || "cadmus.digital"}>`,
      subject: `Welcome to Cadmus — ${name} is ready`,
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:2rem">
          <h2 style="margin-bottom:1rem">Welcome to Cadmus!</h2>
          <p>Your site <strong>${escapeHtml(name)}</strong> has been created and is ready for setup.</p>
          <p style="margin:1.5rem 0">
            <a href="${adminUrl}" style="display:inline-block;padding:0.75rem 1.5rem;background:#1a1a1a;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">
              Open your dashboard
            </a>
          </p>
          <p style="color:#666;font-size:0.875rem">Your site: <a href="${siteUrl}">${siteHost}</a></p>
        </div>
      `,
      text: `Welcome to Cadmus! Your site "${name}" has been created.\n\nOpen your dashboard: ${adminUrl}\nYour site: ${siteUrl}`,
    }).catch((err) => console.error("Failed to send welcome email:", err));
  }

  return c.json(result, 201);
});

// PUT /api/sites/subdomain — change subdomain for an existing site (owner only)
// MUST be registered before PUT /:id so Hono doesn't match "subdomain" as an id param.
sitesRoutes.put("/subdomain", requireRole("owner"), async (c) => {
  const user = c.get("user") as AuthUser;
  const siteId = user.siteId;

  if (!siteId) {
    return c.json({ error: "No site associated with your account" }, 400);
  }

  const body = await c.req.json();
  const { subdomain } = body as { subdomain?: string };

  if (!subdomain) {
    return c.json({ error: "subdomain is required" }, 400);
  }

  const normalized = subdomain.toLowerCase().trim();

  // Validate format
  const RESERVED_SUBDOMAINS = new Set([
    "www", "api", "admin", "dashboard", "mail", "app", "cdn", "static",
    "assets", "cadmus", "support", "help", "billing", "status", "dev",
    "staging", "test", "demo", "example", "localhost",
  ]);

  function isValidSubdomain(sub: string): boolean {
    if (sub.length < 3 || sub.length > 40) return false;
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(sub) && !/^[a-z0-9]$/.test(sub)) return false;
    if (RESERVED_SUBDOMAINS.has(sub)) return false;
    return true;
  }

  if (!isValidSubdomain(normalized)) {
    return c.json({ error: "Invalid subdomain. Use 3–40 lowercase letters, numbers, or hyphens (no leading/trailing hyphens). Some names are reserved." }, 400);
  }

  const [existing] = await db.select().from(sites).where(eq(sites.id, siteId));
  if (!existing) {
    return c.json({ error: "Site not found" }, 404);
  }

  if (existing.subdomain === normalized) {
    return c.json({ error: "That is already your current subdomain" }, 400);
  }

  if (existing.domain) {
    return c.json({ error: "Remove your custom domain before changing your subdomain" }, 400);
  }

  const [conflict] = await db
    .select({ id: sites.id })
    .from(sites)
    .where(and(eq(sites.subdomain, normalized), ne(sites.id, siteId)));

  if (conflict) {
    return c.json({ error: "That subdomain is already taken" }, 409);
  }

  const oldSubdomain = existing.subdomain;
  // Any non-free plan (monthly, annual, or comped) gets the paid perk of a
  // 48hr redirect from the old subdomain. Mirrors the feature gate's "only the
  // free tier is limited" rule.
  const isPaid = existing.plan !== "free";

  // TODO: 48hr redirect requires Cloudflare Worker update — Worker should check
  // previousSubdomain/previousSubdomainExpiresAt and serve 301 if matched.

  const updateValues: Record<string, unknown> = {
    subdomain: normalized,
    updatedAt: new Date(),
  };

  if (isPaid) {
    updateValues.previousSubdomain = oldSubdomain;
    updateValues.previousSubdomainExpiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
  } else {
    updateValues.previousSubdomain = null;
    updateValues.previousSubdomainExpiresAt = null;
  }

  await db.update(sites).set(updateValues).where(eq(sites.id, siteId));

  await db.insert(auditLog).values({
    siteId,
    actorType: "user",
    actorId: user.id,
    action: "site.subdomain_changed",
    entityType: "site",
    entityId: siteId,
    details: { oldSubdomain, newSubdomain: normalized, plan: existing.plan },
  });

  if (isPaid) {
    const baseDomain = process.env.BASE_DOMAIN || "cadmus.digital";
    const [owner] = await db
      .select({ email: users.email })
      .from(siteMembers)
      .innerJoin(users, eq(users.id, siteMembers.userId))
      .where(and(eq(siteMembers.siteId, siteId), eq(siteMembers.role, "owner")));

    if (owner) {
      const emailProvider = getEmailProvider();
      if (emailProvider) {
        emailProvider.send({
          to: owner.email,
          from: `Cadmus <noreply@${process.env.MAILGUN_DOMAIN || "cadmus.digital"}>`,
          subject: "Your Cadmus subdomain has changed",
          html: `
            <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:2rem">
              <h2 style="margin-bottom:1rem">Your subdomain has changed</h2>
              <p>Your Cadmus site's subdomain has been updated:</p>
              <p style="margin:1.25rem 0;font-size:1.1rem">
                <strong>${escapeHtml(oldSubdomain)}.${escapeHtml(baseDomain)}</strong>
                &nbsp;→&nbsp;
                <strong>${escapeHtml(normalized)}.${escapeHtml(baseDomain)}</strong>
              </p>
              <p>Your old URL will redirect to the new one for 48 hours. After that, only the new URL will work.</p>
              <p style="color:#666;font-size:0.875rem">If you didn't make this change, contact support immediately.</p>
            </div>
          `,
          text: `Your Cadmus subdomain has changed.\n\n${oldSubdomain}.${baseDomain} → ${normalized}.${baseDomain}\n\nYour old URL will redirect for 48 hours. After that, only the new URL will work.\n\nIf you didn't make this change, contact support immediately.`,
        }).catch((err) => console.error("Failed to send subdomain change email:", err));
      }
    }
  }

  return c.json({ ok: true, subdomain: normalized });
});

// PUT /api/sites/:id/custom-code — owner-only raw <head>/end-of-body code
// injection (analytics, pixels, chat widgets). Stored UNSANITIZED by design:
// this is the deliberate, trusted escape hatch from the block sanitizer, gated
// to site owners only. Editors/admins cannot set it (the general update strips
// customCode), so it's not a path for stored XSS by lower roles.
sitesRoutes.put("/:id/custom-code", requireRole("owner"), async (c) => {
  const id = c.req.param("id");
  await assertSiteAccess(c, id, "owner");
  const user = c.get("user") as AuthUser;
  const body = await c.req.json<{ head?: string; bodyEnd?: string }>();
  const head = typeof body.head === "string" ? body.head : "";
  const bodyEnd = typeof body.bodyEnd === "string" ? body.bodyEnd : "";

  const [existing] = await db.select({ settings: sites.settings }).from(sites).where(eq(sites.id, id));
  if (!existing) return c.json({ error: "Site not found" }, 404);
  const settings = (existing.settings as Record<string, unknown> | null) ?? {};

  await db
    .update(sites)
    .set({ settings: { ...settings, customCode: { head, bodyEnd } }, updatedAt: new Date() })
    .where(eq(sites.id, id));

  await db.insert(auditLog).values({
    siteId: id,
    actorType: "user",
    actorId: user.id,
    action: "site.custom_code_updated",
    entityType: "site",
    entityId: id,
    details: { headBytes: head.length, bodyEndBytes: bodyEnd.length },
  });

  return c.json({ ok: true });
});

// GET /api/sites/:id/design-intent — the site's persistent design direction.
// Stripped from the public /site response, so the admin reads it here.
sitesRoutes.get("/:id/design-intent", requireRole("editor", "admin", "owner"), async (c) => {
  const id = c.req.param("id");
  await assertSiteAccess(c, id, "editor");
  const [site] = await db.select({ settings: sites.settings }).from(sites).where(eq(sites.id, id));
  if (!site) return c.json({ error: "Site not found" }, 404);
  const settings = (site.settings as Record<string, unknown> | null) ?? {};
  return c.json({ designIntent: (settings.designIntent as DesignIntent | undefined) ?? null });
});

// PUT /api/sites/:id/design-intent — admin-editable design direction. Bumps
// version, stamps source="user-edited". Mirrors the brief-constraints field:
// a place to correct "the AI keeps forgetting we're X".
sitesRoutes.put("/:id/design-intent", requireRole("admin", "owner"), async (c) => {
  const id = c.req.param("id");
  await assertSiteAccess(c, id, "admin");
  const user = c.get("user") as AuthUser;
  const body = await c.req.json<Partial<DesignIntent>>();

  const [existing] = await db.select({ settings: sites.settings }).from(sites).where(eq(sites.id, id));
  if (!existing) return c.json({ error: "Site not found" }, 404);
  const settings = (existing.settings as Record<string, unknown> | null) ?? {};
  const current = settings.designIntent as DesignIntent | undefined;
  const next = mergeDesignIntent(current, body, "user-edited");

  await db
    .update(sites)
    .set({ settings: { ...settings, designIntent: next }, updatedAt: new Date() })
    .where(eq(sites.id, id));

  await db.insert(auditLog).values({
    siteId: id,
    actorType: "user",
    actorId: user.id,
    action: "site.design_intent_updated",
    entityType: "site",
    entityId: id,
    details: { source: "user-edited", version: next.version },
  });

  return c.json({ designIntent: next });
});

// ── SEO files (llms.txt / sitemap.xml / robots.txt) ───────────────────────
// Managed only for indexable (non-free) sites — mirrors the noindex rule in
// apps/web BaseLayout. The admin SEO page reads/writes through these.

async function listPublishedForSeo(siteId: string, type: string, limit: number): Promise<LlmsContentItem[]> {
  return db
    .select({ slug: content.slug, schemaData: content.schemaData })
    .from(content)
    .where(and(eq(content.siteId, siteId), eq(content.status, "published"), eq(content.type, type)))
    .orderBy(desc(content.publishedAt))
    .limit(limit);
}

// GET /api/sites/:id/seo — current SEO files + the deterministic llms.txt so the
// editor can preview/reset-to-auto even when an override is stored.
sitesRoutes.get("/:id/seo", requireRole("editor", "admin", "owner"), async (c) => {
  const id = c.req.param("id");
  await assertSiteAccess(c, id, "editor");

  const [site] = await db.select().from(sites).where(eq(sites.id, id));
  if (!site) return c.json({ error: "Site not found" }, 404);

  const origin = canonicalOrigin(site);
  const settings = (site.settings as Record<string, unknown> | null) ?? {};
  const seo = (settings.seo as Record<string, unknown> | undefined) ?? {};
  const override = typeof seo.llmsTxt === "string" && seo.llmsTxt.trim() ? seo.llmsTxt : null;

  const [pages, posts] = await Promise.all([
    listPublishedForSeo(id, "page", 1000),
    listPublishedForSeo(id, "post", 50),
  ]);

  const generated = buildLlmsTxt({
    siteName: site.name,
    origin,
    brief: (site.brief as SiteBrief | null) ?? null,
    pages,
    posts,
  });

  // Mirror sitemap.xml.ts: "/" + non-home pages + (blog index + posts).
  const nonHomePages = pages.filter((p) => p.slug !== "home").length;
  const sitemapEntryCount = 1 + nonHomePages + (posts.length > 0 ? 1 + posts.length : 0);

  return c.json({
    indexable: site.plan !== "free",
    plan: site.plan,
    llms: { override, generated, url: `${origin}/llms.txt` },
    robots: { url: `${origin}/robots.txt` },
    sitemap: { url: `${origin}/sitemap.xml`, entryCount: sitemapEntryCount },
  });
});

// PUT /api/sites/:id/seo — save (or clear) the llms.txt override. Empty/blank
// clears it, reverting to the deterministic doc.
sitesRoutes.put("/:id/seo", requireRole("admin", "owner"), async (c) => {
  const id = c.req.param("id");
  await assertSiteAccess(c, id, "admin");
  const user = c.get("user") as AuthUser;
  const body = await c.req.json<{ llmsTxt?: string | null }>();

  const [existing] = await db.select({ settings: sites.settings }).from(sites).where(eq(sites.id, id));
  if (!existing) return c.json({ error: "Site not found" }, 404);
  const settings = (existing.settings as Record<string, unknown> | null) ?? {};
  const seo = (settings.seo as Record<string, unknown> | undefined) ?? {};

  const raw = typeof body.llmsTxt === "string" ? body.llmsTxt.trim() : "";
  const value = raw ? (body.llmsTxt as string) : null;
  const nextSeo = { ...seo, llmsTxt: value };

  await db
    .update(sites)
    .set({ settings: { ...settings, seo: nextSeo }, updatedAt: new Date() })
    .where(eq(sites.id, id));

  await db.insert(auditLog).values({
    siteId: id,
    actorType: "user",
    actorId: user.id,
    action: "site.seo_updated",
    entityType: "site",
    entityId: id,
    details: { llmsTxt: value ? "override" : "auto", bytes: raw.length },
  });

  return c.json({ llmsTxt: value });
});

// POST /api/sites/:id/seo/llms/draft — AI-author a richer summary from the brief
// and assemble a full llms.txt draft (NOT persisted; the user reviews/saves).
sitesRoutes.post("/:id/seo/llms/draft", requireRole("admin", "owner"), async (c) => {
  const id = c.req.param("id");
  await assertSiteAccess(c, id, "admin");
  const user = c.get("user") as AuthUser;

  const router = getAIRouter();
  if (!router) return c.json({ error: "AI providers not configured" }, 503);

  const [site] = await db.select().from(sites).where(eq(sites.id, id));
  if (!site) return c.json({ error: "Site not found" }, 404);

  const brief = (site.brief as SiteBrief | null) ?? null;
  const origin = canonicalOrigin(site);
  const [pages, posts] = await Promise.all([
    listPublishedForSeo(id, "page", 1000),
    listPublishedForSeo(id, "post", 50),
  ]);

  const prompt = `Write a concise summary for an llms.txt file (a short guide that helps AI assistants understand a website). 2-3 sentences of plain prose — no markdown, no quotes, no preamble. Describe what the site/business is and who it serves.

Business name: ${brief?.businessName ?? site.name}
Description: ${brief?.businessDescription ?? ""}
${brief?.targetAudience ? `Audience: ${brief.targetAudience}` : ""}
${brief?.primaryGoal ? `Primary goal: ${brief.primaryGoal}` : ""}
${brief?.differentiators ? `Differentiators: ${brief.differentiators}` : ""}

Output only the summary text.`;

  let summary = brief?.businessDescription ?? "";
  try {
    const result = await router.generateText({ task: "copywriting", prompt, maxTokens: 200 });
    const text = result.text.trim();
    if (text) summary = text;
  } catch {
    // Fall back to the deterministic summary on any AI failure.
  }

  const draft = buildLlmsTxt({ siteName: site.name, origin, brief, pages, posts, summary });

  await db.insert(auditLog).values({
    siteId: id,
    actorType: "user",
    actorId: user.id,
    action: "site.seo_llms_drafted",
    entityType: "site",
    entityId: id,
    details: {},
  });

  return c.json({ draft });
});

// Update site
sitesRoutes.put("/:id", requireRole("admin", "owner"), async (c) => {
  const id = c.req.param("id");
  await assertSiteAccess(c, id, "admin");
  const user = c.get("user") as AuthUser;
  const body = await c.req.json();
  const { name, domain, brief, settings, status } = body;

  const [existing] = await db.select().from(sites).where(eq(sites.id, id));
  if (!existing) {
    return c.json({ error: "Site not found" }, 404);
  }

  const existingSettings = (existing.settings as Record<string, unknown> | null) ?? {};

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (name !== undefined) updates.name = name;
  if (domain !== undefined) updates.domain = domain;
  if (brief !== undefined) updates.brief = brief;
  // Top-level merge so partial patches (e.g. `{ logoUrl }` from onboarding)
  // can't silently drop sibling keys like `billingPlan` or `formDefaults`.
  // Callers that need to update a nested field still spread that field
  // themselves (`{ theme: { ...existing.theme, ... } }`).
  const mergedSettings =
    settings !== undefined
      ? { ...existingSettings, ...(settings as Record<string, unknown>) }
      : existingSettings;
  // customCode (raw script injection) is owner-only via PUT /:id/custom-code.
  // Never let it through the general settings update (admins can call this) —
  // preserve whatever is already stored, ignore any incoming value.
  if (settings !== undefined) {
    if ("customCode" in existingSettings) mergedSettings.customCode = existingSettings.customCode;
    else delete mergedSettings.customCode;
  }
  // Sanitize theme header/footer markup (stored raw, rendered via set:html) to
  // strip script/event-handler/javascript: payloads before persisting.
  if (settings !== undefined) {
    const theme = mergedSettings.theme as Record<string, unknown> | undefined;
    if (theme) {
      if (typeof theme.headerHtml === "string") theme.headerHtml = sanitizeHtmlBlock(theme.headerHtml);
      if (typeof theme.footerHtml === "string") theme.footerHtml = sanitizeHtmlBlock(theme.footerHtml);
    }
  }
  if (settings !== undefined) updates.settings = mergedSettings;
  if (status !== undefined) updates.status = status;

  // Detect if the theme actually changed before triggering a recompile —
  // settings updates that only touch businessInfo, postTemplate, etc. should
  // not pay for a Tailwind compile.
  const existingTheme = (existingSettings.theme ?? null) as unknown;
  const nextTheme = (mergedSettings.theme ?? null) as unknown;
  const themeChanged =
    settings !== undefined &&
    JSON.stringify(existingTheme ?? null) !== JSON.stringify(nextTheme ?? null);

  let [updated] = await db
    .update(sites)
    .set(updates)
    .where(eq(sites.id, id))
    .returning();

  if (themeChanged) {
    await recompileSiteCss(id);
    [updated] = await db.select().from(sites).where(eq(sites.id, id));
  }

  await db.insert(auditLog).values({
    siteId: id,
    actorType: "user",
    actorId: user.id,
    action: "site.updated",
    entityType: "site",
    entityId: id,
    details: { changes: Object.keys(updates).filter((k) => k !== "updatedAt") },
  });

  return c.json(updated);
});

// Activate site (transition from onboarding to active)
// Sites start on the free plan — no Stripe customer or subscription is created here.
// Users upgrade to a paid plan via POST /api/billing/upgrade.
sitesRoutes.post("/:id/activate", async (c) => {
  const id = c.req.param("id");
  await assertSiteAccess(c, id, "admin");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const user = (c as any).get("user") as AuthUser;

  const [existing] = await db.select().from(sites).where(eq(sites.id, id));
  if (!existing) {
    return c.json({ error: "Site not found" }, 404);
  }

  if (existing.status !== "onboarding") {
    return c.json({ error: "Site is not in onboarding status" }, 400);
  }

  const [updated] = await db
    .update(sites)
    .set({ status: "active", plan: "free", updatedAt: new Date() })
    .where(eq(sites.id, id))
    .returning();

  await db.insert(auditLog).values({
    siteId: id,
    actorType: "user",
    actorId: user.id,
    action: "site.activated",
    entityType: "site",
    entityId: id,
  });

  return c.json(updated);
});

// Connect custom domain
sitesRoutes.post("/:id/domain", requireRole("owner"), async (c) => {
  const id = c.req.param("id");
  await assertSiteAccess(c, id, "owner");
  const user = c.get("user") as AuthUser;
  const { domain } = await c.req.json();

  if (!domain) {
    return c.json({ error: "domain is required" }, 400);
  }

  const baseDomain = process.env.BASE_DOMAIN || "cadmus.digital";
  const normalized = String(domain).trim().toLowerCase().replace(/^www\./, "");
  if (normalized === baseDomain || normalized.endsWith(`.${baseDomain}`)) {
    return c.json(
      { error: `${baseDomain} and its subdomains can't be connected as a custom domain` },
      400
    );
  }

  const [existing] = await db.select().from(sites).where(eq(sites.id, id));
  if (!existing) {
    return c.json({ error: "Site not found" }, 404);
  }

  // Feature gate: custom domains are not available on free plan
  const domainGate = await checkFeatureGate(id, "custom_domain");
  if (!domainGate.allowed) {
    return c.json(
      { error: domainGate.reason || "Custom domains are not available on the free plan", gate: domainGate },
      403,
    );
  }

  // Payment gate: require a payment method on file for custom domains. Comped /
  // internal sites (plan "comped" or billing "free") are exempt — there's no
  // Stripe customer to attach a card to, and the whole point of comping is to
  // remove billing friction. A stale subscription row must not re-impose it.
  if (!isCompedSite(existing)) {
    const [sub] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.siteId, id));
    if (sub) {
      const [pm] = await db
        .select()
        .from(paymentMethods)
        .where(eq(paymentMethods.subscriptionId, sub.id));
      if (!pm) {
        return c.json(
          { error: "Payment method required to connect a custom domain", action: "add_payment_method" },
          402
        );
      }
    }
  }

  // Check domain isn't already taken
  const [conflict] = await db.select().from(sites).where(eq(sites.domain, domain));
  if (conflict) {
    return c.json({ error: "Domain is already in use" }, 409);
  }

  // Create custom hostname via Cloudflare if provider is configured
  let domainStatus = "pending";
  let domainMeta: Record<string, unknown> = {};
  let verificationCname: { name: string; value: string } | undefined;

  if (customHostnames) {
    const result = await customHostnames.create(domain);
    if (result.status === "failed") {
      // Surface the Cloudflare error in the server logs — otherwise the only
      // record is the HTTP response body, invisible in Cloud Run logs.
      console.error(
        `[custom-hostname] Cloudflare rejected create for "${domain}" (site ${id}):`,
        result.errors,
      );
      return c.json({ error: "Failed to create custom hostname", details: result.errors }, 500);
    }
    domainStatus = result.sslStatus === "active" ? "active" : "pending";
    domainMeta = { cfHostnameId: result.id };
    verificationCname = result.verificationCname;
  }

  const [updated] = await db
    .update(sites)
    .set({ domain, domainStatus, domainMeta, updatedAt: new Date() })
    .where(eq(sites.id, id))
    .returning();

  await db.insert(auditLog).values({
    siteId: id,
    actorType: "user",
    actorId: user.id,
    action: "site.domain_connected",
    entityType: "site",
    entityId: id,
    details: { domain },
  });

  // Build DNS instructions based on whether it's a root domain or subdomain
  const isRootDomain = domain.split(".").length === 2; // e.g. "example.com"
  const instructions: { type: string; name: string; value: string }[] = [];

  if (isRootDomain) {
    instructions.push(
      { type: "CNAME", name: "www", value: "origin.cadmus.digital" },
    );
  } else {
    instructions.push(
      { type: "CNAME", name: domain, value: "origin.cadmus.digital" },
    );
  }

  return c.json({
    site: updated,
    domainStatus,
    isRootDomain,
    dns: {
      instructions,
      message: isRootDomain
        ? "Add a CNAME for www pointing to origin.cadmus.digital. If your DNS provider supports CNAME flattening (e.g. Cloudflare), you can also add a CNAME for the root domain. Otherwise, set up a redirect from your root domain to www."
        : "Add a CNAME record pointing to origin.cadmus.digital. SSL will be provisioned automatically.",
    },
  });
});

// Check domain status
sitesRoutes.get("/:id/domain/status", async (c) => {
  const id = c.req.param("id");
  await assertSiteAccess(c, id);

  const [existing] = await db.select().from(sites).where(eq(sites.id, id));
  if (!existing) {
    return c.json({ error: "Site not found" }, 404);
  }
  if (!existing.domain) {
    return c.json({ error: "No custom domain configured" }, 400);
  }

  const meta = existing.domainMeta as Record<string, unknown> | null;
  const cfHostnameId = meta?.cfHostnameId as string | undefined;

  if (!cfHostnameId || !customHostnames) {
    return c.json({
      domain: existing.domain,
      domainStatus: existing.domainStatus || "pending",
      sslStatus: "pending",
    });
  }

  const result = await customHostnames.getStatus(cfHostnameId);

  // Map to our domain status
  let domainStatus: string;
  if (result.status === "active" && result.sslStatus === "active") {
    domainStatus = "active";
  } else if (result.status === "failed" || result.sslStatus === "failed") {
    domainStatus = "failed";
  } else if (result.status === "active" && result.sslStatus === "pending") {
    domainStatus = "ssl_pending";
  } else {
    domainStatus = "pending";
  }

  // Update DB if status changed
  if (domainStatus !== existing.domainStatus) {
    await db
      .update(sites)
      .set({ domainStatus, updatedAt: new Date() })
      .where(eq(sites.id, id));

    // Domain just went live: if the site has the Turnstile add-on, provision
    // a widget slot for the new hostname (fire-and-forget — activation must
    // never block on it; a later poll or install retries naturally).
    if (domainStatus === "active" && existing.domain) {
      void ensureTurnstileProvisioned(id, existing.domain).catch((err) =>
        console.error(`[turnstile-provision] activation hook failed for site ${id}:`, err),
      );
    }
  }

  return c.json({
    domain: existing.domain,
    domainStatus,
    sslStatus: result.sslStatus,
    errors: result.errors,
  });
});

// Disconnect custom domain
sitesRoutes.delete("/:id/domain", requireRole("owner"), async (c) => {
  const id = c.req.param("id");
  await assertSiteAccess(c, id, "owner");

  const [existing] = await db.select().from(sites).where(eq(sites.id, id));
  if (!existing) {
    return c.json({ error: "Site not found" }, 404);
  }
  if (!existing.domain) {
    return c.json({ error: "No custom domain configured" }, 400);
  }

  // Remove from Cloudflare
  const meta = existing.domainMeta as Record<string, unknown> | null;
  const cfHostnameId = meta?.cfHostnameId as string | undefined;
  if (cfHostnameId && customHostnames) {
    await customHostnames.remove(cfHostnameId);
  }

  const [updated] = await db
    .update(sites)
    .set({ domain: null, domainStatus: null, domainMeta: null, updatedAt: new Date() })
    .where(eq(sites.id, id))
    .returning();

  // Reclaim the site's Turnstile pool slot (best-effort, fire-and-forget).
  void deprovisionTurnstileForDomain(id).catch((err) =>
    console.error(`[turnstile-provision] disconnect cleanup failed for site ${id}:`, err),
  );

  await db.insert(auditLog).values({
    siteId: id,
    actorType: "user",
    action: "site.domain_disconnected",
    entityType: "site",
    entityId: id,
    details: { domain: existing.domain },
  });

  return c.json({ site: updated });
});

// POST /api/sites/:id/recompile-css — Recompile theme.compiledCss against
// every content block on the site. Used by onboarding to coalesce a single
// compile after parallel page generation, instead of one per content.create.
sitesRoutes.post("/:id/recompile-css", requireRole("editor", "admin", "owner"), async (c) => {
  const id = c.req.param("id");
  await assertSiteAccess(c, id, "editor");
  const [existing] = await db.select({ id: sites.id }).from(sites).where(eq(sites.id, id));
  if (!existing) {
    return c.json({ error: "Site not found" }, 404);
  }
  await recompileSiteCss(id);
  return c.json({ success: true });
});

// POST /api/sites/:id/reset — Reset site to onboarding state
// Re-enter onboarding without deleting existing content. Existing pages get
// their slugs renamed to `${slug}-old` (or `-old-2`, `-old-3`, ...) and
// status flipped to draft so the new onboarding pass can create fresh
// pages at the canonical slugs without collision while preserving the
// previous content for the user to recover.
sitesRoutes.post("/:id/restart-onboarding", requireRole("owner", "admin"), async (c) => {
  const id = c.req.param("id");
  await assertSiteAccess(c, id, "admin");
  const [existing] = await db.select().from(sites).where(eq(sites.id, id));
  if (!existing) {
    return c.json({ error: "Site not found" }, 404);
  }

  const settings = (existing.settings as Record<string, unknown>) || {};
  delete settings.skippedOnboarding;
  // Drop the existing theme so the new wizard pass produces fresh colors,
  // fonts, header/footer HTML, and Stitch project state. Without this,
  // theme.colors locks Stitch into the previous palette (its prompt only
  // forwards brief.brandColors when no theme.colors are present), and
  // theme.designerState.stitch.projectId pins generation to the original
  // Stitch project (same design system context). Both must reset for a
  // truly fresh site. Site is in onboarding status, so the gap before the
  // new theme is generated is not user-visible.
  delete settings.theme;

  const user = c.get("user") as AuthUser;
  const archived = await db.transaction(async (tx) => {
    const archivedRows = await archiveContentForRestart(tx, id);

    await tx
      .update(sites)
      .set({ status: "onboarding", brief: null, settings, updatedAt: new Date() })
      .where(eq(sites.id, id));

    await tx.insert(auditLog).values({
      siteId: id,
      actorType: "user",
      actorId: user.id,
      action: "site.restart_onboarding",
      entityType: "site",
      entityId: id,
      details: { archivedCount: archivedRows.length, archived: archivedRows },
    });

    return archivedRows;
  });

  return c.json({ success: true, archivedCount: archived.length });
});

// Full destructive reset — deletes all content and data
sitesRoutes.post("/:id/reset", requireRole("owner"), async (c) => {
  const id = c.req.param("id");
  await assertSiteAccess(c, id, "owner");

  const [existing] = await db.select().from(sites).where(eq(sites.id, id));
  if (!existing) {
    return c.json({ error: "Site not found" }, 404);
  }

  await db.transaction(async (tx) => {
    // Get all content IDs for this site
    const siteContent = await tx
      .select({ id: content.id })
      .from(content)
      .where(eq(content.siteId, id));
    const contentIds = siteContent.map((c) => c.id);

    // Delete content-related data
    if (contentIds.length > 0) {
      for (const cid of contentIds) {
        await tx.delete(contentBlocks).where(eq(contentBlocks.contentId, cid));
        await tx.delete(contentVersions).where(eq(contentVersions.contentId, cid));
        await tx.delete(contentCollections).where(eq(contentCollections.contentId, cid));
        await tx.delete(contentMedia).where(eq(contentMedia.contentId, cid));
      }
      await tx.delete(content).where(eq(content.siteId, id));
    }

    // Delete other site data
    await tx.delete(collections).where(eq(collections.siteId, id));
    await tx.delete(media).where(eq(media.siteId, id));
    await tx.delete(navigation).where(eq(navigation.siteId, id));
    await tx.delete(formSubmissions).where(eq(formSubmissions.siteId, id));
    await tx.delete(aiHistory).where(eq(aiHistory.siteId, id));
    await tx.delete(auditLog).where(eq(auditLog.siteId, id));

    // Reset site to onboarding state
    await tx
      .update(sites)
      .set({
        status: "onboarding",
        brief: null,
        settings: {},
        updatedAt: new Date(),
      })
      .where(eq(sites.id, id));
  });

  const user = c.get("user") as AuthUser;
  await db.insert(auditLog).values({
    siteId: id,
    actorType: "user",
    actorId: user.id,
    action: "site.reset",
    entityType: "site",
    entityId: id,
  });

  return c.json({ success: true });
});

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
