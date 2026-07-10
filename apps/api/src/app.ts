import * as Sentry from "@sentry/node";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { cors } from "hono/cors";
import { tenantMiddleware } from "./middleware/tenant.js";
import { enforceActiveSite } from "./middleware/enforceActiveSite.js";
import { requireAuth, requireRole, requireGlobalRole, requireSiteMembership } from "./middleware/auth.js";
import { createRateLimiter, getClientIp } from "./lib/rate-limit.js";
import { logError } from "./lib/log.js";
import type { AuthUser } from "@cadmus/shared";
import { contentRoutes } from "./routes/content.js";
import { collectionsRoutes } from "./routes/collections.js";
import { mediaRoutes } from "./routes/media.js";
import { sitesRoutes } from "./routes/sites.js";
import { aiRoutes } from "./routes/ai.js";
import { authRoutes } from "./routes/auth.js";
import { navigationRoutes } from "./routes/navigation.js";
import { scheduledTasksRoutes } from "./routes/scheduledTasks.js";
import { publicRoutes } from "./routes/public.js";
import { formSubmissionRoutes } from "./routes/formSubmissions.js";
import { exportRoutes } from "./routes/export.js";
import { importRoutes } from "./routes/import.js";
import { teamRoutes } from "./routes/team.js";
import { billingRoutes } from "./routes/billing.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { adminRoutes } from "./routes/admin.js";
import { mediaStreamRoutes } from "./routes/media-stream.js";
import { sentryAlertsRoutes } from "./routes/sentry-alerts.js";
import { supportRoutes } from "./routes/support.js";
import { redirectsRoutes } from "./routes/redirects.js";
import { healthRoutes } from "./routes/health.js";
import { featureGatesRoutes } from "./routes/feature-gates.js";
import { platformConfigRoutes } from "./routes/platform-config.js";
import { promoRoutes } from "./routes/promo.js";
import { addonsRoutes } from "./routes/addons.js";
import { adminAddonsRoutes } from "./routes/admin-addons.js";
import { adminLogsRoutes } from "./routes/admin-logs.js";
import { partnerRoutes } from "./routes/partner.js";

const app = new Hono();

// CORS policy. Auth is bearer-token only (no cookies), so `*` was never a
// credential-theft risk — but we still restrict authenticated routes to the
// platform's own origins defensively. Public routes stay open because they're
// embedded into tenant sites (including arbitrary custom domains) and called
// from the browser (form submit, search).
const PLATFORM_ORIGIN_RE = /^https?:\/\/([a-z0-9-]+\.)*cadmus\.digital(:\d+)?$/i;
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;
function corsOrigin(origin: string, path: string): string | null {
  if (path.startsWith("/api/public")) return origin || "*";
  // No Origin header → not a cross-origin browser request (server-to-server,
  // webhooks, same-origin); CORS doesn't apply, so any value is harmless.
  if (!origin) return "*";
  return PLATFORM_ORIGIN_RE.test(origin) || LOCALHOST_ORIGIN_RE.test(origin) ? origin : null;
}

app.use("*", cors({
  origin: (origin, c) => corsOrigin(origin, c.req.path),
  exposeHeaders: ["Content-Disposition"],
}));

// Global error handler
app.onError((err, c) => {
  // Mirror the CORS policy on error responses so allowed origins can still read
  // the error body, without broadcasting it to disallowed origins.
  const acao = corsOrigin(c.req.header("origin") || "", c.req.path);
  if (acao) c.header("Access-Control-Allow-Origin", acao);

  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }

  // Malformed JSON body — don't log to Sentry, just return 400
  if (err instanceof SyntaxError && err.message.includes("JSON")) {
    return c.json({ error: "Invalid JSON in request body" }, 400);
  }

  logError(`[api] ${c.req.method} ${c.req.path}`, err);

  Sentry.withScope((scope) => {
    const user = c.get("user" as never) as AuthUser | null | undefined;
    if (user) {
      scope.setUser({ id: user.id, email: user.email });
      scope.setTag("site_id", user.siteId);
    }
    Sentry.captureException(err);
  });

  // Postgres error codes (string only — GCS and other errors may have numeric codes)
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") {
    if (code === "23505") return c.json({ error: "Resource already exists" }, 409);
    if (code === "23503") return c.json({ error: "Referenced resource not found" }, 409);
    if (code === "23502") return c.json({ error: "Missing required field" }, 400);
    if (code === "22001") return c.json({ error: "Value too long for field" }, 400);
    if (code.startsWith("08")) return c.json({ error: "Service temporarily unavailable" }, 503);
  }

  return c.json({ error: "Internal server error" }, 500);
});

app.use("/api/*", tenantMiddleware);

// Public (unauthenticated) read-only routes
app.route("/api/public", publicRoutes);

// Token-authenticated media streaming proxy (staging media preview for review).
// Auth is the signed token in ?t=, not the bearer prefix — mounted here so it
// sits before the requireAuth/site-membership chain below.
app.route("/api/media-stream", mediaStreamRoutes);

// Auth-protected routes
app.use("/api/content/*", requireAuth);
app.use("/api/collections/*", requireAuth);
app.use("/api/media/*", requireAuth);
app.use("/api/sites/*", async (c, next) => {
  // Site provisioning (POST /api/sites) is unauthenticated
  if (c.req.path === "/api/sites" && c.req.method === "POST") {
    return next();
  }
  // Hostname resolution is unauthenticated (used by web frontend)
  if (c.req.path === "/api/sites/resolve") {
    return next();
  }
  return (requireAuth as any)(c, next);
});
// AI rate limits — each request hits a paid provider, so cap abuse while leaving
// normal usage untouched. Keyed by user (not IP) so shared offices aren't
// punished for one teammate.
const aiLimiter = createRateLimiter("ai.general", 30, 60_000);
const aiImageLimiter = createRateLimiter("ai.image", 10, 60_000);

app.use("/api/ai/*", requireAuth, requireSiteMembership, requireRole("editor", "admin", "owner"), async (c, next) => {
  // Job polling is a cheap DB read, not a paid AI call. Exempt it so clients
  // can poll long-running jobs (4 pages × poll-every-3s easily exceeds the
  // 30/min general cap) without getting locked out.
  if (c.req.method === "GET" && c.req.path.startsWith("/api/ai/jobs/")) {
    return next();
  }

  const user = c.get("user") as AuthUser | undefined;
  const ip = getClientIp({
    "x-forwarded-for": c.req.header("x-forwarded-for"),
    "x-real-ip": c.req.header("x-real-ip"),
  });
  const key = user?.id || ip;

  const isImage = c.req.path.startsWith("/api/ai/generate-image");
  const limiter = isImage ? aiImageLimiter : aiLimiter;
  const cap = isImage ? 10 : 30;

  if (!limiter.check(key)) {
    return c.json(
      { error: `AI rate limit reached (${cap} requests per minute). Please wait a moment and try again.` },
      429,
    );
  }
  return next();
});
app.use("/api/navigation/*", requireAuth);
app.use("/api/scheduled-tasks/*", requireAuth);
app.use("/api/form-submissions/*", requireAuth);
app.use("/api/export", requireAuth);
app.use("/api/export/*", requireAuth);
app.use("/api/import/*", requireAuth);
app.use("/api/billing/*", async (c, next) => {
  // Plan list is public — signup page renders pricing before the user has an
  // account. Everything else under /billing requires auth.
  if (c.req.path === "/api/billing/plans" && c.req.method === "GET") {
    return next();
  }
  return (requireAuth as any)(c, next);
});
app.use("/api/addons/*", requireAuth);
app.use("/api/team/*", async (c, next) => {
  // Invite validation and acceptance are unauthenticated (token-based)
  if (c.req.path === "/api/team/validate-invite" && c.req.method === "GET") {
    return next();
  }
  if (c.req.path === "/api/team/accept-invite" && c.req.method === "POST") {
    return next();
  }
  return (requireAuth as any)(c, next);
});

// Enforce that the authenticated user is an active member of the resolved tenant
// site and rebind their effective role to it (closes the x-site-id cross-tenant
// pivot). Runs after the requireAuth prefix mounts above so `user` is set; no-ops
// for unauthenticated/platform paths. Routes mounting requireAuth *after* this
// line (redirects, feature-gates) attach requireSiteMembership inline instead.
app.use("/api/*", requireSiteMembership);

// Block writes on non-active sites (runs after auth so we can bypass for cadmus_admin).
// Skips paths where tenantMiddleware didn't resolve a site (admin/auth/webhooks).
app.use("/api/*", enforceActiveSite);

app.route("/api/content", contentRoutes);
app.route("/api/collections", collectionsRoutes);
app.route("/api/media", mediaRoutes);
app.route("/api/sites", sitesRoutes);
app.route("/api/ai", aiRoutes);
app.route("/api/navigation", navigationRoutes);
app.route("/api/scheduled-tasks", scheduledTasksRoutes);
app.route("/api/form-submissions", formSubmissionRoutes);
app.route("/api/export", exportRoutes);
app.route("/api/import", importRoutes);
app.route("/api/team", teamRoutes);
app.route("/api/billing", billingRoutes);
app.route("/api/addons", addonsRoutes);

// Partner self-service portal (partner accounts, no tenant scoping)
app.use("/api/partner/*", requireAuth, requireGlobalRole("partner"));
app.route("/api/partner", partnerRoutes);

// Platform admin routes (cadmus_admin only, no tenant scoping)
app.use("/api/admin/*", requireAuth, requireGlobalRole("cadmus_admin"));
app.route("/api/admin", adminRoutes);
app.route("/api/admin", adminAddonsRoutes);
app.route("/api/admin", adminLogsRoutes);
app.route("/api/admin", platformConfigRoutes);
app.route("/api/admin/sentry", sentryAlertsRoutes);
app.route("/api/support", supportRoutes);
app.use("/api/redirects/*", requireAuth, requireSiteMembership);
app.route("/api/redirects", redirectsRoutes);

app.use("/api/feature-gates/*", requireAuth, requireSiteMembership);
app.route("/api/feature-gates", featureGatesRoutes);

// Unprotected routes
app.route("/api/auth", authRoutes);
app.route("/api/promo", promoRoutes);
app.route("/api/webhooks", webhookRoutes);
app.route("/api/health", healthRoutes);

// Build/version info — fed by GIT_SHA and APP_ENV env vars set at deploy time.
app.get("/api/version", (c) =>
  c.json({
    app: "api",
    env: process.env.APP_ENV ?? null,
    gitSha: process.env.GIT_SHA ?? null,
    gitTag: process.env.GIT_TAG ?? null,
    builtAt: process.env.BUILT_AT ?? null,
  }),
);

export { app };
