import { defineMiddleware } from "astro:middleware";

const BASE_DOMAIN = import.meta.env.BASE_DOMAIN || process.env.BASE_DOMAIN || "cadmus.digital";
const API_URL = import.meta.env.PUBLIC_API_URL || process.env.PUBLIC_API_URL || "http://localhost:8080";

// In-memory cache: hostname → { siteId, canonicalHost, expiresAt }
// canonicalHost is the active custom domain when present, otherwise null.
const cache = new Map<string, { siteId: string; canonicalHost: string | null; expiresAt: number }>();
const CACHE_TTL_MS = 60_000; // 1 minute

// Per-site redirect rules cache (short TTL — rules change infrequently)
const redirectsCache = new Map<string, { items: Array<{ fromPath: string; toUrl: string; statusCode: number }>; expiresAt: number }>();
const REDIRECTS_CACHE_TTL_MS = 60_000;

async function checkRedirect(siteId: string, pathname: string): Promise<{ toUrl: string; statusCode: number } | null> {
  const rules = await getRedirectsForSite(siteId);
  const matchedPath = pathname.endsWith("/") && pathname !== "/" ? pathname.slice(0, -1) : pathname;
  return rules.find((r) => r.fromPath === pathname || r.fromPath === matchedPath) ?? null;
}

async function getRedirectsForSite(siteId: string): Promise<Array<{ fromPath: string; toUrl: string; statusCode: number }>> {
  const cached = redirectsCache.get(siteId);
  if (cached && cached.expiresAt > Date.now()) return cached.items;

  try {
    const res = await fetch(`${API_URL}/api/public/redirects`, {
      headers: { "x-site-id": siteId },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { items: Array<{ fromPath: string; toUrl: string; statusCode: number }> };
    const items = data.items ?? [];
    redirectsCache.set(siteId, { items, expiresAt: Date.now() + REDIRECTS_CACHE_TTL_MS });
    return items;
  } catch {
    return [];
  }
}

// IPv4 (with optional port) or IPv6 (bracketed, or bare — hostnames never
// contain colons, so hex-and-colons means an IPv6 literal).
function isIpLiteral(hostname: string): boolean {
  const host = hostname.replace(/:\d+$/, "");
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) return true;
  return hostname.startsWith("[") || (host.includes(":") && /^[0-9a-fA-F:]+$/.test(host));
}

export const onRequest = defineMiddleware(async (context, next) => {
  const { request, locals, redirect } = context;
  const url = new URL(request.url);
  const hostname = request.headers.get("x-forwarded-host") || request.headers.get("host") || url.hostname;

  // Health check endpoint — used by deploy pipeline; never needs site resolution
  if (url.pathname === "/health") {
    return next();
  }

  // Build/version info — fetched cross-tenant by the platform monitoring page;
  // never needs site resolution.
  if (url.pathname === "/version.json") {
    return next();
  }

  // Cloud Run service URL — only infra endpoints (/health, /version.json, handled
  // above) are valid here. Real traffic always arrives via *.cadmus.digital or a
  // custom domain, so any other path is a bot probing the raw service URL: there is
  // no site to resolve, and serving a content route would leave locals.siteId unset
  // and throw downstream. Return 404 instead of a 500.
  if (hostname.endsWith(".run.app")) {
    return new Response("Not found", { status: 404 });
  }

  // IP-literal Host header — bots scanning the load balancer IP directly. An IP
  // can never resolve to a site, so skip the API round trip entirely.
  if (isIpLiteral(hostname)) {
    return new Response("Not found", { status: 404 });
  }

  // Handle admin subdomain → redirect to admin SPA
  if (hostname === `admin.${BASE_DOMAIN}`) {
    // In production, admin is served from GCS or its own Cloud Run service
    return redirect("https://admin.cadmus.digital/", 302);
  }

  // Bare domain resolves through the normal API path (cadmus.digital is a real site)
  // www → redirect to apex
  if (hostname === `www.${BASE_DOMAIN}`) {
    return redirect(`https://${BASE_DOMAIN}${url.pathname}`, 301);
  }

  // Check cache first
  const cached = cache.get(hostname);
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.canonicalHost && cached.canonicalHost !== hostname) {
      return redirect(`https://${cached.canonicalHost}${url.pathname}${url.search}`, 301);
    }
    locals.siteId = cached.siteId;
    const cachedRedirect = await checkRedirect(cached.siteId, url.pathname);
    if (cachedRedirect) return redirect(cachedRedirect.toUrl, cachedRedirect.statusCode as 301 | 302 | 307 | 308);
    return next();
  }

  // Resolve hostname → siteId via API
  try {
    const res = await fetch(`${API_URL}/api/sites/resolve?hostname=${encodeURIComponent(hostname)}`);
    if (!res.ok) {
      return new Response("Site not found", { status: 404 });
    }

    const data = (await res.json()) as {
      siteId: string;
      name: string;
      status: string;
      domain: string | null;
      domainStatus: string | null;
    };

    if (data.status === "suspended" || data.status === "archived") {
      return new Response(renderSuspendedPage(data.name), {
        status: 403,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    const canonicalHost = data.domain && data.domainStatus === "active" ? data.domain : null;

    // Cache the result
    cache.set(hostname, { siteId: data.siteId, canonicalHost, expiresAt: Date.now() + CACHE_TTL_MS });

    if (canonicalHost && canonicalHost !== hostname) {
      return redirect(`https://${canonicalHost}${url.pathname}${url.search}`, 301);
    }

    locals.siteId = data.siteId;
  } catch {
    // API unavailable — fall back to env var for dev
    locals.siteId = import.meta.env.PUBLIC_SITE_ID || "demo";
  }

  // Check URL redirects before serving the page
  if (locals.siteId) {
    const rule = await checkRedirect(locals.siteId as string, url.pathname);
    if (rule) return redirect(rule.toUrl, rule.statusCode as 301 | 302 | 307 | 308);
  }

  return next();
});

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function renderSuspendedPage(siteName: string): string {
  const safeName = escapeHtml(siteName || "This site");
  const adminUrl = `https://${BASE_DOMAIN}/admin`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>${safeName} is inactive</title>
  <style>
    *,*::before,*::after { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; height: 100%; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #fafaf9;
      color: #1c1917;
      display: flex;
      flex-direction: column;
      min-height: 100%;
    }
    main {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 2rem;
    }
    .card {
      max-width: 520px;
      width: 100%;
      background: #fff;
      border: 1px solid #e7e5e4;
      border-radius: 12px;
      padding: 2.5rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.04);
      text-align: center;
    }
    .brand {
      font-weight: 700;
      letter-spacing: 0.02em;
      font-size: 0.875rem;
      color: #78716c;
      text-transform: uppercase;
      margin-bottom: 1.5rem;
    }
    h1 {
      font-size: 1.5rem;
      margin: 0 0 0.75rem;
      color: #1c1917;
    }
    p { color: #57534e; line-height: 1.55; margin: 0.5rem 0; }
    .cta {
      display: inline-block;
      margin-top: 1.5rem;
      padding: 0.75rem 1.5rem;
      background: #1c1917;
      color: #fff;
      text-decoration: none;
      border-radius: 8px;
      font-weight: 600;
      font-size: 0.9375rem;
    }
    .cta:hover { background: #44403c; }
    .help {
      margin-top: 1.5rem;
      padding-top: 1.5rem;
      border-top: 1px solid #e7e5e4;
      font-size: 0.875rem;
      color: #78716c;
    }
    .help a { color: #1c1917; }
    footer {
      text-align: center;
      padding: 1rem;
      font-size: 0.8125rem;
      color: #a8a29e;
    }
    footer a { color: #78716c; text-decoration: none; }
  </style>
</head>
<body>
  <main>
    <div class="card">
      <div class="brand">Cadmus</div>
      <h1>${safeName} is inactive</h1>
      <p>This site isn't accepting visitors right now.</p>
      <p>If you're the owner, sign in to reactivate it.</p>
      <a class="cta" href="${adminUrl}">Sign in to Cadmus</a>
      <div class="help">
        Need help? Contact <a href="mailto:support@cadmus.digital">support@cadmus.digital</a>.
      </div>
    </div>
  </main>
  <footer>
    Powered by <a href="https://cadmus.digital">Cadmus</a>
  </footer>
</body>
</html>`;
}
