import crypto from "node:crypto";
import { z } from "zod";
import { Hono } from "hono";
import { eq, and, inArray, ne, sql } from "drizzle-orm";
import { db, users, sites, siteMembers, auditLog, promotions, promoRedemptions, partners, partnerSites, referrals } from "@cadmus/db";
import { requireAuth, signToken } from "../middleware/auth.js";
import { hashPassword, verifyPassword, meetsPasswordRequirements, dummyVerify, passwordNeedsRehash } from "../lib/password.js";
import { hashToken } from "../lib/tokens.js";
import { verifyHandoffToken } from "../lib/handoff.js";
import { readValidatedJson } from "../lib/validate.js";
import { getEmailProvider } from "../lib/email.js";
import { createRateLimiter, getClientIp } from "../lib/rate-limit.js";
import type { AuthUser, Locale, SiteMembership } from "@cadmus/shared";
import { SUPPORTED_LOCALES } from "@cadmus/shared";

// Brute-force protection: 10 failed attempts per IP per 15 minutes.
// Window resets only when an attempt succeeds (we call reset() on success).
const loginLimiter = createRateLimiter("auth.login", 10, 15 * 60_000);

// Subdomain availability check: 30 per IP per minute
const subdomainCheckLimiter = createRateLimiter("auth.subdomain_check", 30, 60_000);

// Resend verification: 3 per user per hour
const resendVerificationLimiter = createRateLimiter("auth.resend_verification", 3, 60 * 60_000);

// Account creation: 10 per IP per hour — bounds mass signup/enumeration abuse.
const signupLimiter = createRateLimiter("auth.signup", 10, 60 * 60_000);
// Password-reset request: 5 per IP per 15 min — limits reset-email mailbombing.
const forgotPasswordLimiter = createRateLimiter("auth.forgot_password", 5, 15 * 60_000);
// Reset submission: 10 per IP per 15 min — limits reset-token guessing.
const resetPasswordLimiter = createRateLimiter("auth.reset_password", 10, 15 * 60_000);

function clientIp(c: { req: { header: (k: string) => string | undefined } }): string {
  return getClientIp({
    "x-forwarded-for": c.req.header("x-forwarded-for"),
    "x-real-ip": c.req.header("x-real-ip"),
  });
}

// Request body schemas. Email isn't constrained to a strict format on login
// (accept whatever was registered); signup validates format. Password length is
// bounded here; the complexity rule stays in meetsPasswordRequirements.
const signupSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(255),
  password: z.string().min(1).max(200),
  promoCode: z.string().trim().max(100).optional(),
  // Referral/partner code from a ?ref= link — attributes the signup.
  referralCode: z.string().trim().max(100).optional(),
  // Agency client code from a ?client= link — adds the agency partner as a
  // site admin and creates a pending billing link. Disclosed on the signup page.
  clientCode: z.string().trim().max(100).optional(),
});
const loginSchema = z.object({
  email: z.string().trim().min(1).max(255),
  password: z.string().min(1).max(200),
  siteId: z.string().uuid().optional(),
});
const forgotPasswordSchema = z.object({ email: z.string().trim().min(1).max(255) });
const resetPasswordSchema = z.object({
  token: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(200),
});
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(1).max(200),
});
const handoffSchema = z.object({ token: z.string().min(1).max(1024) });

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

const ADJECTIVES = ["swift", "bold", "bright", "calm", "clean", "crisp", "fresh", "keen", "smart", "solid"];
const NOUNS = ["site", "page", "hub", "spot", "base", "space", "nest", "node", "desk", "zone"];

async function generateAvailableSubdomain(excludeSiteId?: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
    const num = Math.floor(Math.random() * 900) + 100;
    const candidate = `${adj}-${noun}-${num}`;
    const conditions = excludeSiteId
      ? and(eq(sites.subdomain, candidate), ne(sites.id, excludeSiteId))
      : eq(sites.subdomain, candidate);
    const [existing] = await db.select({ id: sites.id }).from(sites).where(conditions);
    if (!existing) return candidate;
  }
  // Fallback: use random bytes
  return `site-${crypto.randomBytes(5).toString("hex")}`;
}

async function suggestSubdomain(base: string, currentSiteId: string): Promise<string> {
  let i = 2;
  while (i < 100) {
    const candidate = `${base}-${i}`;
    if (candidate.length > 40) break;
    const [existing] = await db
      .select({ id: sites.id })
      .from(sites)
      .where(and(eq(sites.subdomain, candidate), ne(sites.id, currentSiteId)));
    if (!existing) return candidate;
    i++;
  }
  return await generateAvailableSubdomain(currentSiteId);
}

// Reset/verification tokens live in the DB hashed so a read-only DB leak doesn't
// expose usable links. The raw token is only ever in the email; when the user
// submits it back we hash the input and compare. (Shared with team invites.)
const hashResetToken = hashToken;

export const authRoutes = new Hono();

/** Fetch all site memberships for a user */
async function getUserMemberships(userId: string): Promise<SiteMembership[]> {
  const rows = await db
    .select({
      siteId: siteMembers.siteId,
      siteName: sites.name,
      subdomain: sites.subdomain,
      domain: sites.domain,
      domainStatus: sites.domainStatus,
      role: siteMembers.role,
      status: siteMembers.status,
    })
    .from(siteMembers)
    .innerJoin(sites, eq(sites.id, siteMembers.siteId))
    .where(and(eq(siteMembers.userId, userId), eq(siteMembers.status, "active")));

  // The platform apex (BASE_DOMAIN), when used as a site's custom domain, is
  // served directly and never reaches "active" via the Cloudflare custom-host
  // flow — treat it as active so "View site" points at it. (Mirrors /resolve.)
  const baseDomain = process.env.BASE_DOMAIN || "cadmus.digital";

  return rows.map((r) => ({
    siteId: r.siteId,
    siteName: r.siteName,
    subdomain: r.subdomain,
    domain: r.domain ?? null,
    domainStatus: r.domain && r.domain === baseDomain ? "active" : (r.domainStatus ?? null),
    role: r.role as SiteMembership["role"],
    status: r.status,
  }));
}

// Returns the siteId of the first active site among the user's memberships,
// or null if none. When `defaultSiteId` is provided, returns null unless that
// default site is itself non-active (i.e. only "falls back" when we have to).
async function pickActiveFallback(
  defaultSiteId: string | null,
  memberships: SiteMembership[]
): Promise<string | null> {
  if (memberships.length === 0) return null;
  const ids = memberships.map((m) => m.siteId);
  const rows = await db
    .select({ id: sites.id, status: sites.status })
    .from(sites)
    .where(inArray(sites.id, ids));
  const statusById = new Map(rows.map((r) => [r.id, r.status]));

  if (defaultSiteId) {
    const defaultStatus = statusById.get(defaultSiteId);
    // Default is active (or unknown — leave alone) → no fallback needed.
    if (!defaultStatus || defaultStatus === "active") return null;
  }

  const active = memberships.find((m) => statusById.get(m.siteId) === "active");
  return active?.siteId ?? null;
}

/** Build AuthUser from DB user + site_members for a specific site */
async function buildAuthUser(dbUser: typeof users.$inferSelect, siteId: string): Promise<AuthUser> {
  // Look up the user's role for this site from site_members. Partner-portal
  // sessions carry an empty siteId — skip the lookup (an empty string would
  // also fail the uuid cast in Postgres).
  const [membership] = siteId
    ? await db
        .select()
        .from(siteMembers)
        .where(and(eq(siteMembers.userId, dbUser.id), eq(siteMembers.siteId, siteId)))
    : [undefined];

  const globalRole = (dbUser.globalRole as AuthUser["globalRole"]) || "user";
  // Platform admins get implicit site-admin role on any site they inspect
  const role = membership?.role || (globalRole === "cadmus_admin" ? "admin" : dbUser.role);

  const rawLocale = (dbUser.preferences as Record<string, unknown> | null)?.locale;
  const locale = SUPPORTED_LOCALES.includes(rawLocale as Locale) ? (rawLocale as Locale) : undefined;

  return {
    id: dbUser.id,
    email: dbUser.email,
    firstName: dbUser.firstName ?? undefined,
    lastName: dbUser.lastName ?? undefined,
    role,
    siteId,
    globalRole,
    emailVerifiedAt: dbUser.emailVerifiedAt ?? null,
    tokenVersion: dbUser.tokenVersion ?? 0,
    locale,
  };
}

// ── POST /signup ────────────────────────────────────────────────────────────
// New free-tier signup: creates account + site, returns JWT, no Stripe.

authRoutes.post("/signup", async (c) => {
  if (!signupLimiter.check(clientIp(c))) {
    return c.json({ error: "Too many signups from this network. Please try again later." }, 429);
  }

  const { name, email, password, promoCode, referralCode, clientCode } = await readValidatedJson(c, signupSchema);

  if (!meetsPasswordRequirements(password)) {
    return c.json({ error: "Password must be at least 12 characters and include an uppercase letter and a number or symbol" }, 400);
  }

  // If the email is already registered, normally block (log in instead). The
  // exception: an ORPHANED account — a plain user with no active site
  // memberships left after their last site was purged — can RECLAIM it by
  // signing up again, keeping its identity (referral code/history) and getting
  // a fresh site. We only reclaim globalRole "user" so signup can never hijack
  // a partner/admin account.
  const [existingUser] = await db.select().from(users).where(eq(users.email, email));
  let reclaimUser: typeof users.$inferSelect | null = null;
  if (existingUser) {
    const [activeMembership] = await db
      .select({ id: siteMembers.id })
      .from(siteMembers)
      .where(and(eq(siteMembers.userId, existingUser.id), eq(siteMembers.status, "active")))
      .limit(1);
    if (activeMembership || existingUser.globalRole !== "user") {
      return c.json({ error: "An account with this email already exists. Please log in instead." }, 409);
    }
    reclaimUser = existingUser;
  }

  // Validate promo code if provided
  let validatedPromo: typeof promotions.$inferSelect | null = null;
  if (promoCode) {
    const [promo] = await db.select().from(promotions).where(eq(promotions.code, promoCode.toLowerCase()));
    if (promo && promo.isActive) {
      const now = new Date();
      const notExpired = !promo.expiresAt || promo.expiresAt > now;
      const notOverLimit = promo.maxRedemptions === null || promo.redemptionCount < promo.maxRedemptions;
      if (notExpired && notOverLimit) validatedPromo = promo;
    }
  }

  // Resolve an inbound ?ref= code into the referrer. A partner's code (e.g.
  // "WEBDEV2026") attributes the signup to that partner's user account;
  // otherwise fall back to a personal user referral code (ref-xxxx). Invalid
  // codes are ignored so they never block signup.
  // Agency client-invite code (?client=). Resolves only to ACTIVE partners
  // with the agency flag — a plain referral partner's code doesn't grant site
  // access. The signup page disclosed the arrangement before this point.
  let agencyPartner: typeof partners.$inferSelect | null = null;
  if (clientCode) {
    const [p] = await db.select().from(partners).where(eq(partners.code, clientCode.trim().toUpperCase()));
    if (p && p.status === "active" && p.isAgency) {
      agencyPartner = p;
    }
  }

  let referrerUserId: string | null = null;
  let resolvedReferralCode: string | null = null;
  // A client signup is the agency's own managed site — no referral commission
  // on top of the billing relationship.
  if (referralCode && !agencyPartner) {
    const code = referralCode.trim();
    const [partner] = await db.select().from(partners).where(eq(partners.code, code.toUpperCase()));
    if (partner && partner.status === "active") {
      referrerUserId = partner.userId;
      resolvedReferralCode = partner.code;
    } else {
      const [refUser] = await db
        .select({ id: users.id, referralCode: users.referralCode })
        .from(users)
        .where(eq(users.referralCode, code));
      if (refUser?.referralCode) {
        referrerUserId = refUser.id;
        resolvedReferralCode = refUser.referralCode;
      }
    }
  }

  const rawVerificationToken = crypto.randomBytes(32).toString("hex");
  const verificationTokenHash = hashResetToken(rawVerificationToken);
  const verificationTokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const passwordHash = hashPassword(password);
  // Generate a temporary placeholder subdomain; user will set it in /signup/subdomain
  const tempSubdomain = `site-${crypto.randomBytes(6).toString("hex")}`;

  const promoEndsAt = validatedPromo
    ? new Date(Date.now() + validatedPromo.trialDays * 24 * 60 * 60 * 1000)
    : undefined;
  const appliedPlan = validatedPromo?.planOverride ?? "free";

  const { newSite, owner } = await db.transaction(async (tx) => {
    const [s] = await tx
      .insert(sites)
      .values({
        name,
        subdomain: tempSubdomain,
        status: "onboarding",
        plan: appliedPlan,
        promoEndsAt,
        promoCode: validatedPromo?.code ?? null,
        settings: {},
      })
      .returning();

    let o: typeof users.$inferSelect;
    if (reclaimUser) {
      // Reclaim an orphaned account: keep the row (and its referral code/history)
      // but attach the fresh site, reset the password, and require re-verification.
      const referralCode = reclaimUser.referralCode ?? `ref-${crypto.randomBytes(4).toString("hex")}`;
      [o] = await tx
        .update(users)
        .set({
          siteId: s.id,
          role: "owner",
          passwordHash,
          referralCode,
          emailVerifiedAt: null,
          emailVerificationToken: verificationTokenHash,
          emailVerificationTokenExpiresAt: verificationTokenExpiry,
        })
        .where(eq(users.id, reclaimUser.id))
        .returning();
    } else {
      const userReferralCode = `ref-${crypto.randomBytes(4).toString("hex")}`;
      [o] = await tx
        .insert(users)
        .values({
          siteId: s.id,
          email,
          role: "owner",
          passwordHash,
          referralCode: userReferralCode,
          emailVerificationToken: verificationTokenHash,
          emailVerificationTokenExpiresAt: verificationTokenExpiry,
        })
        .returning();
    }

    await tx.insert(siteMembers).values({
      siteId: s.id,
      userId: o.id,
      role: "owner",
      joinedAt: new Date(),
      status: "active",
    });

    // Attribute the signup to a referrer (partner or user) if a valid code was
    // used. Qualifies to "qualified" on first payment (see webhooks.ts).
    if (referrerUserId && resolvedReferralCode && referrerUserId !== o.id) {
      await tx.insert(referrals).values({
        referrerUserId,
        referredSiteId: s.id,
        referralCode: resolvedReferralCode,
        status: "pending",
      });
    }

    // Agency client signup: the partner becomes an admin member immediately
    // (disclosed on the signup page) and gets a PENDING billing link —
    // billingActive flips only once billing is actually arranged (partner pays
    // via the site's normal upgrade flow, or staff toggles it).
    if (agencyPartner && agencyPartner.userId !== o.id) {
      await tx.insert(siteMembers).values({
        siteId: s.id,
        userId: agencyPartner.userId,
        role: "admin",
        joinedAt: new Date(),
        status: "active",
      });
      await tx.insert(partnerSites).values({
        partnerId: agencyPartner.id,
        siteId: s.id,
        billingActive: false,
      });
      await tx.insert(auditLog).values({
        siteId: s.id,
        actorType: "system",
        action: "partner.client_linked",
        entityType: "site",
        entityId: s.id,
        details: { partnerId: agencyPartner.id, partnerCode: agencyPartner.code, partnerUserId: agencyPartner.userId },
      });
    }

    await tx.insert(auditLog).values({
      siteId: s.id,
      actorType: "user",
      actorId: o.id,
      action: "site.provisioned",
      entityType: "site",
      entityId: s.id,
      details: {
        ownerEmail: email,
        plan: appliedPlan,
        promoCode: validatedPromo?.code,
        referralCode: resolvedReferralCode ?? undefined,
        reclaimed: reclaimUser ? true : undefined,
      },
    });

    return { newSite: s, owner: o };
  });

  // Record promo redemption outside the main transaction (non-critical)
  if (validatedPromo) {
    await db.insert(promoRedemptions).values({
      promoId: validatedPromo.id,
      siteId: newSite.id,
      userId: owner.id,
      ipAddress: getClientIp({
        "x-forwarded-for": c.req.header("x-forwarded-for"),
        "x-real-ip": c.req.header("x-real-ip"),
      }),
    }).catch((err) => console.error("Failed to record promo redemption:", err));

    await db.update(promotions)
      .set({ redemptionCount: sql`${promotions.redemptionCount} + 1`, updatedAt: new Date() })
      .where(eq(promotions.id, validatedPromo.id))
      .catch((err) => console.error("Failed to increment promo redemption count:", err));
  }

  // Notify the agency partner about their new client site (fire-and-forget).
  if (agencyPartner && agencyPartner.userId !== owner.id) {
    void (async () => {
      const emailProvider = getEmailProvider();
      if (!emailProvider) return;
      const [partnerUser] = await db.select({ email: users.email }).from(users).where(eq(users.id, agencyPartner.userId));
      if (!partnerUser) return;
      await emailProvider.send({
        to: partnerUser.email,
        from: "Cadmus <noreply@cadmus.digital>",
        subject: `New client site: ${name}`,
        html: `
          <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:2rem">
            <h2>A client signed up through your link</h2>
            <p><strong>${name.replace(/</g, "&lt;")}</strong> (${email.replace(/</g, "&lt;")}) just created a site through your client-invite link.</p>
            <p>You've been added as an admin. To put the site on your billing, open the site's Account page and upgrade with your payment method.</p>
          </div>
        `,
      });
    })().catch((err) => console.error("Agency client notification failed:", err));
  }

  const authUser: AuthUser = {
    id: owner.id,
    email: owner.email,
    role: "owner",
    siteId: newSite.id,
    globalRole: "user",
    emailVerifiedAt: null,
  };

  const token = await signToken(authUser);

  // Send verification email (fire-and-forget)
  const emailProvider = getEmailProvider();
  if (emailProvider) {
    const baseDomain = process.env.BASE_DOMAIN || "cadmus.digital";
    const verifyUrl = `https://${baseDomain}/admin/verify-email?token=${rawVerificationToken}`;
    emailProvider.send({
      to: email,
      from: `Cadmus <noreply@${process.env.MAILGUN_DOMAIN || "cadmus.digital"}>`,
      subject: "Verify your Cadmus email",
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:2rem">
          <h2 style="margin-bottom:1rem">Welcome to Cadmus!</h2>
          <p>Please verify your email address to continue setting up your site.</p>
          <p style="margin:1.5rem 0">
            <a href="${verifyUrl}" style="display:inline-block;padding:0.75rem 1.5rem;background:#1a1a1a;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">
              Verify Email
            </a>
          </p>
          <p style="color:#666;font-size:0.875rem">This link expires in 24 hours. If you didn't create a Cadmus account, you can safely ignore this email.</p>
        </div>
      `,
      text: `Welcome to Cadmus! Verify your email: ${verifyUrl}\n\nThis link expires in 24 hours.`,
    }).catch((err) => console.error("Failed to send verification email:", err));
  }

  return c.json({ token, user: authUser, promoApplied: !!validatedPromo }, 201);
});

// ── POST /login ─────────────────────────────────────────────────────────────

authRoutes.post("/login", async (c) => {
  const { email, password, siteId: requestedSiteId } = await readValidatedJson(c, loginSchema);

  const ip = getClientIp({
    "x-forwarded-for": c.req.header("x-forwarded-for"),
    "x-real-ip": c.req.header("x-real-ip"),
  });
  const rateLimitKey = `${ip}:${String(email).toLowerCase()}`;
  if (!loginLimiter.check(rateLimitKey)) {
    return c.json(
      { error: "Too many login attempts. Please try again in 15 minutes." },
      429,
    );
  }

  const [user] = await db.select().from(users).where(eq(users.email, email));
  if (!user || !user.passwordHash) {
    // Burn a comparable amount of CPU so response timing doesn't reveal whether
    // the email is registered, and return a uniform message (no enumeration).
    dummyVerify(password);
    return c.json({ error: "Invalid email or password" }, 401);
  }

  if (!verifyPassword(password, user.passwordHash)) {
    return c.json({ error: "Invalid email or password" }, 401);
  }

  // Password verified — clear the counter so normal use doesn't accumulate hits.
  loginLimiter.reset(rateLimitKey);

  // Transparently upgrade legacy / lower-iteration hashes now that we have the
  // plaintext in hand.
  if (passwordNeedsRehash(user.passwordHash)) {
    await db.update(users).set({ passwordHash: hashPassword(password) }).where(eq(users.id, user.id));
  }

  // Get all active memberships
  const memberships = await getUserMemberships(user.id);

  // Determine which site to log into
  let targetSiteId: string;
  if (requestedSiteId) {
    // Caller requested a specific site — verify membership
    const match = memberships.find((m) => m.siteId === requestedSiteId);
    if (!match) {
      return c.json({ error: "You are not a member of this site" }, 403);
    }
    targetSiteId = match.siteId;
  } else if (user.siteId) {
    // Use default site (may not have a site_member entry yet for legacy users).
    // If the default is suspended/archived and the user has an active
    // membership elsewhere, prefer that so they can still get in without a
    // manual site switch.
    targetSiteId = user.siteId;
    targetSiteId = (await pickActiveFallback(user.siteId, memberships)) ?? targetSiteId;
  } else if (memberships.length > 0) {
    targetSiteId = (await pickActiveFallback(null, memberships)) ?? memberships[0].siteId;
  } else if (user.globalRole === "partner") {
    // Pure referral/agency partner with no sites yet: log them in with no site
    // context — the admin SPA routes them to the partner portal.
    targetSiteId = "";
  } else {
    return c.json({ error: "This account has no active sites. Sign up to start a new one." }, 403);
  }

  const authUser = await buildAuthUser(user, targetSiteId);
  authUser.memberships = memberships;

  // Block login to non-active sites unless user is owner/admin (site) or cadmus_admin (platform).
  // Platform admins always get through; site admins see the read-only banner.
  const [targetSite] = targetSiteId
    ? await db.select().from(sites).where(eq(sites.id, targetSiteId))
    : [undefined];
  if (targetSite && targetSite.status !== "active") {
    const isPrivileged =
      authUser.globalRole === "cadmus_admin" ||
      authUser.role === "owner" ||
      authUser.role === "admin";
    if (!isPrivileged) {
      return c.json(
        { error: `This site is ${targetSite.status}. Contact the site owner.`, status: targetSite.status },
        403
      );
    }
  }

  const token = await signToken(authUser);

  return c.json({ token, user: authUser });
});

// ── POST /set-subdomain ─────────────────────────────────────────────────────

authRoutes.post("/set-subdomain", requireAuth, async (c) => {
  const jwtUser = c.get("user") as AuthUser;
  const body = await c.req.json();
  const { subdomain } = body as { subdomain?: string };

  if (!subdomain) {
    return c.json({ error: "subdomain is required" }, 400);
  }

  const normalized = subdomain.toLowerCase().trim();
  if (!isValidSubdomain(normalized)) {
    return c.json({ error: "Invalid subdomain. Use 3–40 lowercase letters, numbers, or hyphens (no leading/trailing hyphens). Some names are reserved." }, 400);
  }

  // Must have a site
  const siteId = jwtUser.siteId;
  if (!siteId) {
    return c.json({ error: "No site associated with your account" }, 400);
  }

  // Check uniqueness (excluding current site)
  const [conflict] = await db
    .select({ id: sites.id })
    .from(sites)
    .where(and(eq(sites.subdomain, normalized), ne(sites.id, siteId)));

  if (conflict) {
    return c.json({ error: "That subdomain is already taken" }, 409);
  }

  const [updated] = await db
    .update(sites)
    .set({ subdomain: normalized, updatedAt: new Date() })
    .where(eq(sites.id, siteId))
    .returning({ subdomain: sites.subdomain });

  await db.insert(auditLog).values({
    siteId,
    actorType: "user",
    actorId: jwtUser.id,
    action: "site.subdomain_set",
    entityType: "site",
    entityId: siteId,
    details: { subdomain: normalized },
  });

  return c.json({ ok: true, subdomain: updated.subdomain });
});

// ── GET /check-subdomain ─────────────────────────────────────────────────────

authRoutes.get("/check-subdomain", requireAuth, async (c) => {
  const jwtUser = c.get("user") as AuthUser;
  const ip = getClientIp({
    "x-forwarded-for": c.req.header("x-forwarded-for"),
    "x-real-ip": c.req.header("x-real-ip"),
  });
  if (!subdomainCheckLimiter.check(ip)) {
    return c.json({ error: "Too many requests. Please wait a minute." }, 429);
  }

  const subdomain = c.req.query("subdomain");
  if (!subdomain) {
    return c.json({ error: "subdomain query parameter is required" }, 400);
  }

  const normalized = subdomain.toLowerCase().trim();
  const siteId = jwtUser.siteId;

  if (!isValidSubdomain(normalized)) {
    return c.json({ available: false });
  }

  const conditions = siteId
    ? and(eq(sites.subdomain, normalized), ne(sites.id, siteId))
    : eq(sites.subdomain, normalized);
  const [existing] = await db.select({ id: sites.id }).from(sites).where(conditions);

  if (!existing) {
    return c.json({ available: true });
  }

  // Suggest an alternative
  const suggestion = await suggestSubdomain(normalized, siteId ?? "");
  return c.json({ available: false, suggestion });
});

// ── GET /suggest-subdomain ───────────────────────────────────────────────────

authRoutes.get("/suggest-subdomain", requireAuth, async (c) => {
  const jwtUser = c.get("user") as AuthUser;
  const subdomain = await generateAvailableSubdomain(jwtUser.siteId ?? undefined);
  return c.json({ subdomain });
});

// ── GET /verify-email ────────────────────────────────────────────────────────

authRoutes.get("/verify-email", async (c) => {
  const token = c.req.query("token");
  if (!token) {
    return c.json({ error: "token query parameter is required" }, 400);
  }

  const tokenHash = hashResetToken(token);
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.emailVerificationToken, tokenHash));

  if (!user) {
    return c.json({ error: "Invalid or expired verification link" }, 400);
  }

  if (!user.emailVerificationTokenExpiresAt || new Date() > user.emailVerificationTokenExpiresAt) {
    await db
      .update(users)
      .set({ emailVerificationToken: null, emailVerificationTokenExpiresAt: null })
      .where(eq(users.id, user.id));
    return c.json({ error: "This verification link has expired. Please request a new one." }, 400);
  }

  await db
    .update(users)
    .set({
      emailVerifiedAt: new Date(),
      emailVerificationToken: null,
      emailVerificationTokenExpiresAt: null,
    })
    .where(eq(users.id, user.id));

  return c.json({ ok: true });
});

// ── POST /resend-verification ─────────────────────────────────────────────────

authRoutes.post("/resend-verification", requireAuth, async (c) => {
  const jwtUser = c.get("user") as AuthUser;

  if (!resendVerificationLimiter.check(jwtUser.id)) {
    return c.json({ error: "You can only resend the verification email 3 times per hour." }, 429);
  }

  const [dbUser] = await db.select().from(users).where(eq(users.id, jwtUser.id));
  if (!dbUser) {
    return c.json({ error: "User not found" }, 404);
  }

  if (dbUser.emailVerifiedAt) {
    return c.json({ error: "Email is already verified" }, 400);
  }

  const emailProvider = getEmailProvider();
  if (!emailProvider) {
    return c.json({ error: "Email service unavailable" }, 503);
  }

  const rawVerificationToken = crypto.randomBytes(32).toString("hex");
  const verificationTokenHash = hashResetToken(rawVerificationToken);
  const verificationTokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await db
    .update(users)
    .set({
      emailVerificationToken: verificationTokenHash,
      emailVerificationTokenExpiresAt: verificationTokenExpiry,
    })
    .where(eq(users.id, jwtUser.id));

  const baseDomain = process.env.BASE_DOMAIN || "cadmus.digital";
  const verifyUrl = `https://${baseDomain}/admin/verify-email?token=${rawVerificationToken}`;

  await emailProvider.send({
    to: dbUser.email,
    from: `Cadmus <noreply@${process.env.MAILGUN_DOMAIN || "cadmus.digital"}>`,
    subject: "Verify your Cadmus email",
    html: `
      <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:2rem">
        <h2 style="margin-bottom:1rem">Verify your email</h2>
        <p>Click the button below to verify your Cadmus email address.</p>
        <p style="margin:1.5rem 0">
          <a href="${verifyUrl}" style="display:inline-block;padding:0.75rem 1.5rem;background:#1a1a1a;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">
            Verify Email
          </a>
        </p>
        <p style="color:#666;font-size:0.875rem">This link expires in 24 hours. If you didn't request this, you can safely ignore this email.</p>
      </div>
    `,
    text: `Verify your Cadmus email: ${verifyUrl}\n\nThis link expires in 24 hours.`,
  }).catch((err) => console.error("Failed to send verification email:", err));

  return c.json({ ok: true });
});

// ── POST /handoff — exchange a dashboard handoff token for a session ─────────
// Unauthenticated by design: the short-lived handoff token IS the credential.
// Re-verifies the user is still cadmus_admin so a demoted/removed admin can't
// ride a stale token into a site.

authRoutes.post("/handoff", async (c) => {
  const { token } = await readValidatedJson(c, handoffSchema);

  const payload = await verifyHandoffToken(token);
  if (!payload) {
    return c.json({ error: "Invalid or expired handoff token" }, 401);
  }

  const [dbUser] = await db.select().from(users).where(eq(users.id, payload.userId));
  if (!dbUser) {
    return c.json({ error: "Invalid handoff token" }, 401);
  }
  if (dbUser.globalRole !== "cadmus_admin") {
    return c.json({ error: "Handoff is not permitted for this account" }, 403);
  }

  const [site] = await db.select({ id: sites.id }).from(sites).where(eq(sites.id, payload.siteId));
  if (!site) {
    return c.json({ error: "Site not found" }, 404);
  }

  const authUser = await buildAuthUser(dbUser, payload.siteId);
  authUser.memberships = await getUserMemberships(dbUser.id);
  const sessionToken = await signToken(authUser);

  return c.json({ token: sessionToken, user: authUser });
});

// ── POST /switch-site ────────────────────────────────────────────────────────

authRoutes.post("/switch-site", requireAuth, async (c) => {
  const jwtUser = c.get("user") as AuthUser;
  const { siteId } = await c.req.json();

  if (!siteId) {
    return c.json({ error: "siteId is required" }, 400);
  }

  const [membership] = await db
    .select()
    .from(siteMembers)
    .where(and(eq(siteMembers.userId, jwtUser.id), eq(siteMembers.siteId, siteId), eq(siteMembers.status, "active")));

  const isCadmusAdmin = jwtUser.globalRole === "cadmus_admin";
  if (!membership && !isCadmusAdmin) {
    return c.json({ error: "You are not a member of this site" }, 403);
  }

  // For cadmus_admin without membership, verify the site actually exists
  if (!membership) {
    const [targetSite] = await db.select().from(sites).where(eq(sites.id, siteId));
    if (!targetSite) {
      return c.json({ error: "Site not found" }, 404);
    }
  }

  // Update default site (only persist for members — admins shouldn't have their default reset by inspection)
  if (membership) {
    await db.update(users).set({ siteId }).where(eq(users.id, jwtUser.id));
  }

  const [dbUser] = await db.select().from(users).where(eq(users.id, jwtUser.id));
  const authUser = await buildAuthUser(dbUser!, siteId);
  authUser.memberships = await getUserMemberships(jwtUser.id);

  const token = await signToken(authUser);

  return c.json({ token, user: authUser });
});

// ── POST /change-password ───────────────────────────────────────────────────

authRoutes.post("/change-password", requireAuth, async (c) => {
  const authUser = c.get("user") as AuthUser;
  const { currentPassword, newPassword } = await readValidatedJson(c, changePasswordSchema);

  if (!meetsPasswordRequirements(newPassword)) {
    return c.json({ error: "Password must be at least 12 characters and include an uppercase letter and a number or symbol" }, 400);
  }

  const [user] = await db.select().from(users).where(eq(users.id, authUser.id));
  if (!user || !user.passwordHash) {
    return c.json({ error: "Account not found" }, 404);
  }

  if (!verifyPassword(currentPassword, user.passwordHash)) {
    return c.json({ error: "Current password is incorrect" }, 401);
  }

  const newHash = hashPassword(newPassword);
  // Bump tokenVersion to invalidate every OTHER session, then re-issue a token
  // for THIS session so the user who just changed their password stays logged in.
  const [updated] = await db
    .update(users)
    .set({ passwordHash: newHash, tokenVersion: sql`${users.tokenVersion} + 1` })
    .where(eq(users.id, authUser.id))
    .returning();

  if (authUser.siteId) {
    await db.insert(auditLog).values({
      siteId: authUser.siteId,
      actorType: "user",
      actorId: authUser.id,
      action: "account.password_changed",
      entityType: "user",
      entityId: authUser.id,
    });
  }

  const refreshed = await buildAuthUser(updated, authUser.siteId);
  refreshed.memberships = await getUserMemberships(authUser.id);
  const token = await signToken(refreshed);

  return c.json({ ok: true, token });
});

// ── GET /me ─────────────────────────────────────────────────────────────────

authRoutes.get("/me", requireAuth, async (c) => {
  const jwtUser = c.get("user") as AuthUser;
  const [dbUser] = await db.select().from(users).where(eq(users.id, jwtUser.id));
  if (!dbUser) {
    return c.json({ user: jwtUser });
  }

  // Coerce to "" for site-less partner sessions so the payload shape stays
  // consistent (string, not null) across login/me/refresh.
  const siteId = jwtUser.siteId || dbUser.siteId || "";
  const authUser = await buildAuthUser(dbUser, siteId);
  authUser.memberships = await getUserMemberships(dbUser.id);

  // Re-issue the token if the JWT's role data is stale (e.g. globalRole was
  // granted after login, or email was verified). Prevents the frontend from
  // thinking it has a privilege the token doesn't actually carry.
  const stale =
    jwtUser.globalRole !== authUser.globalRole ||
    jwtUser.role !== authUser.role ||
    String(jwtUser.emailVerifiedAt ?? null) !== String(authUser.emailVerifiedAt ?? null);
  if (stale) {
    const token = await signToken(authUser);
    return c.json({ token, user: authUser });
  }

  return c.json({ user: authUser });
});

// ── PUT /profile ─────────────────────────────────────────────────────────────

authRoutes.put("/profile", requireAuth, async (c) => {
  const authUser = c.get("user") as AuthUser;
  const body = await c.req.json();
  const { firstName, lastName, locale } = body as { firstName?: string; lastName?: string; locale?: string };

  if (locale !== undefined && !SUPPORTED_LOCALES.includes(locale as Locale)) {
    return c.json({ error: "Unsupported locale" }, 400);
  }

  const updates: Record<string, unknown> = {};
  if (firstName !== undefined) updates.firstName = firstName.trim() || null;
  if (lastName !== undefined) updates.lastName = lastName.trim() || null;
  if (locale !== undefined) {
    // Merge into the jsonb preferences blob rather than overwriting it.
    updates.preferences = sql`coalesce(${users.preferences}, '{}'::jsonb) || ${JSON.stringify({ locale })}::jsonb`;
  }

  if (Object.keys(updates).length === 0) {
    return c.json({ error: "No fields to update" }, 400);
  }

  const [updated] = await db
    .update(users)
    .set(updates)
    .where(eq(users.id, authUser.id))
    .returning();

  if (authUser.siteId) {
    await db.insert(auditLog).values({
      siteId: authUser.siteId,
      actorType: "user",
      actorId: authUser.id,
      action: "account.profile_updated",
      entityType: "user",
      entityId: authUser.id,
      details: { fields: Object.keys(updates) },
    });
  }

  const freshUser = await buildAuthUser(updated, authUser.siteId);
  return c.json({ user: freshUser });
});

// ── POST /forgot-password ───────────────────────────────────────────────────

authRoutes.post("/forgot-password", async (c) => {
  if (!forgotPasswordLimiter.check(clientIp(c))) {
    return c.json({ error: "Too many password-reset requests. Please try again later." }, 429);
  }

  const { email } = await readValidatedJson(c, forgotPasswordSchema);

  if (!email) {
    return c.json({ error: "email is required" }, 400);
  }

  // Always return success to avoid email enumeration
  const successResponse = { ok: true, message: "If an account exists with that email, a reset link has been sent." };

  const [user] = await db.select().from(users).where(eq(users.email, email));
  if (!user) {
    return c.json(successResponse);
  }

  const emailProvider = getEmailProvider();
  if (!emailProvider) {
    console.error("forgot-password: no email provider configured");
    return c.json(successResponse);
  }

  // Generate a secure reset token (expires in 1 hour). Email the raw token,
  // store only the hash.
  const resetToken = crypto.randomBytes(32).toString("hex");
  const resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000);

  await db
    .update(users)
    .set({ resetToken: hashResetToken(resetToken), resetTokenExpiry })
    .where(eq(users.id, user.id));

  // Build reset URL — use the admin app path on the base domain
  const baseDomain = process.env.BASE_DOMAIN || "cadmus.digital";
  const resetUrl = `https://${baseDomain}/admin/reset-password?token=${resetToken}`;

  await emailProvider.send({
    to: user.email,
    from: `Cadmus <noreply@${process.env.MAILGUN_DOMAIN || "cadmus.digital"}>`,
    subject: "Reset your password",
    html: `
      <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:2rem">
        <h2 style="margin-bottom:1rem">Reset your password</h2>
        <p>We received a request to reset the password for your Cadmus account.</p>
        <p style="margin:1.5rem 0">
          <a href="${resetUrl}" style="display:inline-block;padding:0.75rem 1.5rem;background:#1a1a1a;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">
            Reset Password
          </a>
        </p>
        <p style="color:#666;font-size:0.875rem">This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>
      </div>
    `,
    text: `Reset your password by visiting: ${resetUrl}\n\nThis link expires in 1 hour. If you didn't request this, you can safely ignore this email.`,
  }).catch((err) => {
    console.error("Failed to send password reset email:", err);
  });

  return c.json(successResponse);
});

// ── POST /reset-password ────────────────────────────────────────────────────

authRoutes.post("/reset-password", async (c) => {
  if (!resetPasswordLimiter.check(clientIp(c))) {
    return c.json({ error: "Too many attempts. Please try again later." }, 429);
  }

  const { token, newPassword } = await readValidatedJson(c, resetPasswordSchema);

  if (!meetsPasswordRequirements(newPassword)) {
    return c.json({ error: "Password must be at least 12 characters and include an uppercase letter and a number or symbol" }, 400);
  }

  const [user] = await db.select().from(users).where(eq(users.resetToken, hashResetToken(token)));
  if (!user) {
    return c.json({ error: "Invalid or expired reset link" }, 400);
  }

  if (!user.resetTokenExpiry || new Date() > user.resetTokenExpiry) {
    // Clear the expired token
    await db.update(users).set({ resetToken: null, resetTokenExpiry: null }).where(eq(users.id, user.id));
    return c.json({ error: "This reset link has expired. Please request a new one." }, 400);
  }

  const newHash = hashPassword(newPassword);
  // Bump tokenVersion so any sessions opened before the reset (incl. an
  // attacker's, which is often why a reset happens) are immediately invalidated.
  await db
    .update(users)
    .set({
      passwordHash: newHash,
      resetToken: null,
      resetTokenExpiry: null,
      tokenVersion: sql`${users.tokenVersion} + 1`,
      // Completing a reset proves inbox ownership — counts as verification.
      // Matters for invited partner stubs, which never went through signup.
      emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
    })
    .where(eq(users.id, user.id));

  if (user.siteId) {
    await db.insert(auditLog).values({
      siteId: user.siteId,
      actorType: "user",
      actorId: user.id,
      action: "account.password_reset",
      entityType: "user",
      entityId: user.id,
    });
  }

  return c.json({ ok: true, message: "Password has been reset. You can now sign in." });
});
