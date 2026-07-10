import { createMiddleware } from "hono/factory";
import { eq, or } from "drizzle-orm";
import { db, sites } from "@cadmus/db";

const BASE_DOMAIN = process.env.BASE_DOMAIN || "cadmus.digital";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SiteContext = {
  siteId: string;
  subdomain: string;
  domain: string | null;
  status: string;
};

export type SiteEnv = {
  Variables: { site: SiteContext };
};

// Resolves the current site from the request hostname.
// Matches against subdomain (e.g. site-abc123.cadmus.digital) or custom domain.
// Skips resolution for API requests that don't require a site context
// (e.g. health check, signup/provisioning).
export const tenantMiddleware = createMiddleware<{
  Variables: { site: SiteContext };
}>(async (c, next) => {
  const hostname = c.req.header("host")?.split(":")[0] || "";

  // Skip tenant resolution for platform-level routes
  const path = c.req.path;
  if (path.startsWith("/api/health") || path.startsWith("/api/auth") || path.startsWith("/api/webhooks") || path.startsWith("/api/admin") || path.startsWith("/api/partner") || path.startsWith("/api/media-stream") || path.startsWith("/api/support") || path.startsWith("/api/promo") || path === "/api/version" || path === "/api/team/accept-invite" || path === "/api/team/validate-invite" || path === "/api/sites/resolve" || path === "/api/sites" && c.req.method === "POST" || (path === "/api/billing/plans" && c.req.method === "GET")) {
    return next();
  }

  // Explicit siteId in header takes priority (for admin API calls)
  const explicitSiteId = c.req.header("x-site-id");
  if (explicitSiteId) {
    if (!UUID_RE.test(explicitSiteId)) {
      return c.json({ error: "Invalid x-site-id format" }, 400);
    }
    const [site] = await db
      .select()
      .from(sites)
      .where(eq(sites.id, explicitSiteId));

    if (!site) {
      return c.json({ error: "Site not found" }, 404);
    }

    // Note: status enforcement is handled by enforceActiveSite middleware (after auth),
    // which can distinguish read vs. write and cadmus_admin overrides.
    c.set("site", {
      siteId: site.id,
      subdomain: site.subdomain,
      domain: site.domain,
      status: site.status,
    });
    return next();
  }

  // Resolve from hostname
  let site: typeof sites.$inferSelect | undefined;

  if (hostname.endsWith(`.${BASE_DOMAIN}`)) {
    // Subdomain match: site-abc123.cadmus.digital
    const subdomain = hostname.replace(`.${BASE_DOMAIN}`, "");
    const [found] = await db
      .select()
      .from(sites)
      .where(eq(sites.subdomain, subdomain));
    site = found;
  } else if (hostname !== BASE_DOMAIN && hostname !== `www.${BASE_DOMAIN}`) {
    // Custom domain match
    const [found] = await db
      .select()
      .from(sites)
      .where(eq(sites.domain, hostname));
    site = found;
  }

  if (!site) {
    return c.json({ error: "Site not found for this hostname" }, 404);
  }

  // Status enforcement lives in enforceActiveSite (after auth); hostname-based public
  // requests get blocked at the web layer (apps/web/src/middleware.ts) for suspended sites.
  c.set("site", {
    siteId: site.id,
    subdomain: site.subdomain,
    domain: site.domain,
    status: site.status,
  });

  return next();
});
