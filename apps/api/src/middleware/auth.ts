import { createMiddleware } from "hono/factory";
import { jwtVerify, SignJWT } from "jose";
import { and, eq } from "drizzle-orm";
import { db, siteMembers, users } from "@cadmus/db";
import type { AuthUser, SiteRole, GlobalRole } from "@cadmus/shared";
import { jwtSecretKey as secret } from "../lib/jwt-secret.js";
import type { SiteContext } from "./tenant.js";

export async function signToken(payload: AuthUser): Promise<string> {
  // Only persist core fields in JWT (not memberships list)
  const { memberships: _, ...jwtPayload } = payload;
  return new SignJWT({ ...jwtPayload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(secret);
}

async function verifyToken(token: string): Promise<AuthUser | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    return {
      id: payload.id as string,
      email: payload.email as string,
      role: payload.role as string,
      siteId: payload.siteId as string,
      globalRole: (payload.globalRole as AuthUser["globalRole"]) || "user",
      tokenVersion: (payload.tokenVersion as number) ?? 0,
    };
  } catch {
    return null;
  }
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

// Revocation check: a JWT carries the tokenVersion it was minted at. If the
// user's current version (bumped on password change/reset/forced logout) is
// higher, the token is stale and rejected. Returns false if the user no longer
// exists. NOTE: this adds one indexed PK lookup per authenticated request —
// acceptable for now, a candidate for a short-TTL cache later.
async function tokenVersionValid(user: AuthUser): Promise<boolean> {
  const [row] = await db.select({ v: users.tokenVersion }).from(users).where(eq(users.id, user.id));
  if (!row) return false;
  return row.v === (user.tokenVersion ?? 0);
}

export const requireAuth = createMiddleware<{
  Variables: { user: AuthUser };
}>(async (c, next) => {
  const token = extractBearerToken(c.req.header("authorization"));
  if (!token) {
    return c.json({ error: "Authorization header is required" }, 401);
  }

  const user = await verifyToken(token);
  if (!user) {
    return c.json({ error: "Invalid or expired token" }, 401);
  }

  if (!(await tokenVersionValid(user))) {
    return c.json({ error: "Session expired. Please log in again." }, 401);
  }

  c.set("user", user);
  return next();
});

export const optionalAuth = createMiddleware<{
  Variables: { user: AuthUser | null };
}>(async (c, next) => {
  const token = extractBearerToken(c.req.header("authorization"));
  if (token) {
    const user = await verifyToken(token);
    c.set("user", user && (await tokenVersionValid(user)) ? user : null);
  } else {
    c.set("user", null);
  }
  return next();
});

// Role hierarchy: owner > admin > editor > viewer
const ROLE_HIERARCHY: Record<SiteRole, number> = {
  owner: 4,
  admin: 3,
  editor: 2,
  viewer: 1,
};

/**
 * Middleware that passes if the user's site role is at least the LOWEST of the
 * listed roles in the owner > admin > editor > viewer hierarchy. The args are
 * "this role or any higher one" — NOT a set that all must be matched. So
 * requireRole("editor", "admin", "owner") and requireRole("editor") are
 * equivalent (both mean "editor or above"); list only the minimum role to avoid
 * confusion. Uses the role bound to the request by requireSiteMembership (which
 * rebinds it to the resolved site); must run after requireAuth.
 */
export function requireRole(...allowedRoles: SiteRole[]) {
  return createMiddleware<{
    Variables: { user: AuthUser };
  }>(async (c, next) => {
    const user = c.get("user");
    if (!user) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const userLevel = ROLE_HIERARCHY[user.role as SiteRole] || 0;
    // Lowest listed role = the threshold (everyone at or above it passes).
    const minLevel = Math.min(...allowedRoles.map((r) => ROLE_HIERARCHY[r] || 0));

    if (userLevel >= minLevel) {
      return next();
    }

    return c.json({ error: "Insufficient permissions" }, 403);
  });
}

/**
 * Middleware that checks the user's global role (e.g. cadmus_admin).
 * Must be used after requireAuth.
 */
export function requireGlobalRole(...roles: GlobalRole[]) {
  return createMiddleware<{
    Variables: { user: AuthUser };
  }>(async (c, next) => {
    const user = c.get("user");
    if (!user || !roles.includes(user.globalRole as GlobalRole)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    return next();
  });
}

/**
 * Returns the user's role on a site from an ACTIVE site_members row, or null
 * if they are not an active member. The single source of truth for "does this
 * user belong to this site, and as what role".
 */
export async function getActiveMembershipRole(
  userId: string,
  siteId: string,
): Promise<SiteRole | null> {
  const [membership] = await db
    .select({ role: siteMembers.role })
    .from(siteMembers)
    .where(
      and(
        eq(siteMembers.userId, userId),
        eq(siteMembers.siteId, siteId),
        eq(siteMembers.status, "active"),
      ),
    );
  return (membership?.role as SiteRole) ?? null;
}

/**
 * Enforces that the authenticated user is an active member of the resolved
 * tenant site (the one set by tenantMiddleware from the hostname or x-site-id
 * header) and rebinds the request's effective role/siteId to THAT site.
 *
 * Without this, an owner of site X could send `x-site-id: <site Y>` plus their
 * own valid token and act on site Y, because requireRole only sees the role
 * baked into their JWT (their role on their *own* site). This middleware closes
 * that cross-tenant hole and makes requireRole evaluate against the site the
 * request is actually touching.
 *
 * No-ops when there is no resolved site (platform/auth/webhook paths) or no
 * authenticated user (public, unauthenticated routes) — those are gated
 * elsewhere. cadmus_admin is treated as admin on any site (matches buildAuthUser
 * and the switch-site handler). Idempotent within a request via the
 * `membershipChecked` flag so it can be registered both inline and globally.
 *
 * NOTE: routes that act on a site id taken from the URL/body (e.g.
 * sites.ts `/:id`) must additionally verify membership against THAT id —
 * this middleware only governs the tenant-resolved site context.
 */
export const requireSiteMembership = createMiddleware<{
  Variables: {
    site?: SiteContext;
    user?: AuthUser;
    membershipChecked?: boolean;
  };
}>(async (c, next) => {
  if (c.get("membershipChecked")) return next();

  const site = c.get("site");
  const user = c.get("user");

  if (site && user) {
    if (user.globalRole === "cadmus_admin") {
      c.set("user", { ...user, role: "admin", siteId: site.siteId });
    } else {
      const role = await getActiveMembershipRole(user.id, site.siteId);
      if (!role) {
        return c.json({ error: "You do not have access to this site" }, 403);
      }
      c.set("user", { ...user, role, siteId: site.siteId });
    }
  }

  c.set("membershipChecked", true);
  return next();
});
