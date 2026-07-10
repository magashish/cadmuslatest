import { createMiddleware } from "hono/factory";
import type { AuthUser } from "@cadmus/shared";
import type { SiteContext } from "./tenant.js";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Gates writes on suspended/archived sites. Read requests always pass through
 * so the admin UI can load a read-only view with a suspension banner.
 * `onboarding` sites allow writes — the interview and initial setup need them.
 * cadmus_admin users bypass this gate entirely (platform operators can still
 * intervene).
 *
 * Must be registered after tenantMiddleware and after requireAuth on any path
 * where this check should apply (so both `site` and `user` are in context).
 */
export const enforceActiveSite = createMiddleware<{
  Variables: { site?: SiteContext; user?: AuthUser };
}>(async (c, next) => {
  const site = c.get("site");
  if (!site) return next(); // tenant didn't resolve — admin/auth/webhook paths

  if (site.status === "active" || site.status === "onboarding") return next();

  if (READ_METHODS.has(c.req.method)) return next();

  const user = c.get("user");
  if (user?.globalRole === "cadmus_admin") return next();

  return c.json(
    { error: `Site is ${site.status}`, status: site.status },
    403
  );
});
