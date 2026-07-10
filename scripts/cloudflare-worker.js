// Environment configs
const ENVS = {
  prod: {
    admin: "https://storage.googleapis.com/cadmus-84-admin",
    dashboard: "https://storage.googleapis.com/cadmus-84-dashboard",
    api: "cadmus-api-115874405946.us-central1.run.app",
    web: "cadmus-web-115874405946.us-central1.run.app",
    baseDomain: "cadmus.digital",
  },
  dev: {
    admin: "https://storage.googleapis.com/cadmus-84-admin-dev",
    dashboard: "https://storage.googleapis.com/cadmus-84-dashboard-dev",
    api: "cadmus-api-dev-bzjv5pktgq-uc.a.run.app",
    web: "cadmus-web-dev-bzjv5pktgq-uc.a.run.app",
    baseDomain: "dev.cadmus.digital",
  },
};

// Dev uses single-level subdomains to stay under *.cadmus.digital SSL:
//   api-dev.cadmus.digital          → dev API
//   dev.cadmus.digital/admin        → dev admin SPA
//   {subdomain}--dev.cadmus.digital → dev site (e.g. site-abc123--dev.cadmus.digital)

function getEnv(hostname) {
  if (hostname === "api-dev.cadmus.digital") return ENVS.dev;
  if (hostname === "dev.cadmus.digital") return ENVS.dev;
  if (hostname === "dashboard-dev.cadmus.digital") return ENVS.dev;
  if (hostname.endsWith("--dev.cadmus.digital")) return ENVS.dev;
  return ENVS.prod;
}

function isDashboardRequest(hostname) {
  return hostname === "dashboard.cadmus.digital" || hostname === "dashboard-dev.cadmus.digital";
}

function isAdminRequest(hostname, pathname) {
  if (!pathname.startsWith("/admin")) return false;
  return hostname === "cadmus.digital" || hostname === "www.cadmus.digital" || hostname === "dev.cadmus.digital";
}

function isApiRequest(hostname) {
  return hostname === "api.cadmus.digital" || hostname === "api-dev.cadmus.digital";
}

// Baseline security headers applied to every response. CSP is intentionally
// omitted — it couples to user-generated HTML blocks and needs its own pass.
// X-Frame-Options is conditional: SPAs and API get DENY, public sites stay
// framable so the admin preview iframe keeps working.
// HSTS only advertises includeSubDomains+preload on cadmus.digital (we own it);
// customer custom domains get a plain max-age so we don't accidentally break
// their other subdomains or lock them into Chrome's preload list.
function applySecurityHeaders(headers, { allowFraming, hostname }) {
  const isOwnedDomain = hostname === "cadmus.digital" || hostname.endsWith(".cadmus.digital");
  const hsts = isOwnedDomain
    ? "max-age=31536000; includeSubDomains; preload"
    : "max-age=31536000";
  headers.set("Strict-Transport-Security", hsts);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  if (!allowFraming) {
    headers.set("X-Frame-Options", "DENY");
  }
}

// Used when a cross-origin JSON resource (e.g. /version.json) is requested
// but missing on the bucket — returns a 404 with CORS so the caller sees a
// real fetch error rather than a CORS-blocked HTML SPA fallback.
function jsonNotFound(hostname) {
  const headers = new Headers();
  headers.set("Content-Type", "application/json");
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Cadmus-Worker", "1");
  applySecurityHeaders(headers, { allowFraming: false, hostname });
  return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers });
}

// For dev site subdomains, translate the hostname for the web app.
// The web app resolves tenants via X-Forwarded-Host. For dev, a request to
// site-abc123--dev.cadmus.digital needs to be resolved as if it were
// site-abc123.dev.cadmus.digital so the API can look up the subdomain.
function getForwardedHost(hostname, env) {
  if (env === ENVS.dev && hostname.endsWith("--dev.cadmus.digital")) {
    // Extract the site subdomain: "site-abc123--dev.cadmus.digital" → "site-abc123"
    const siteSubdomain = hostname.replace("--dev.cadmus.digital", "");
    return `${siteSubdomain}.dev.cadmus.digital`;
  }
  return hostname;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const hostname = url.hostname;
    const env = getEnv(hostname);

    // Promo vanity URLs — cadmus.digital/go/:slug → API promo redirect endpoint
    // The API looks up the slug in the DB and issues a 302 to /admin/signup?promo=CODE
    if ((hostname === "cadmus.digital" || hostname === "www.cadmus.digital") && url.pathname.startsWith("/go/")) {
      const slug = url.pathname.slice(4); // strip /go/
      const promoUrl = new URL(request.url);
      promoUrl.hostname = ENVS.prod.api;
      promoUrl.pathname = `/api/promo/redirect/${encodeURIComponent(slug)}`;
      const promoHeaders = new Headers();
      promoHeaders.set("Host", ENVS.prod.api);
      promoHeaders.set("X-Forwarded-Host", hostname);
      const promoReq = new Request(promoUrl, { method: "GET", headers: promoHeaders, redirect: "manual" });
      const promoRes = await fetch(promoReq);
      const resHeaders = new Headers(promoRes.headers);
      resHeaders.set("X-Cadmus-Worker", "1");
      return new Response(promoRes.body, { status: promoRes.status, headers: resHeaders });
    }

    // Serve dashboard SPA from GCS for dashboard.cadmus.digital
    if (isDashboardRequest(hostname)) {
      const assetPath = url.pathname || "/";

      // If it looks like a static asset, fetch it directly
      if (assetPath.match(/\.\w+$/)) {
        const res = await fetch(`${env.dashboard}${assetPath}`);
        if (res.ok) {
          const headers = new Headers(res.headers);
          headers.set("Cache-Control", assetPath.startsWith("/assets/")
            ? "public, max-age=31536000, immutable"
            : "no-cache");
          headers.set("X-Cadmus-Worker", "1");
          // Monitoring page fetches version.json across environments — allow CORS.
          if (assetPath === "/version.json") {
            headers.set("Access-Control-Allow-Origin", "*");
            headers.set("Cache-Control", "no-store");
          }
          applySecurityHeaders(headers, { allowFraming: false, hostname });
          return new Response(res.body, { status: res.status, headers });
        }
        // version.json is fetched cross-origin by the Monitoring page; if it's
        // missing, return a CORS-allowed JSON 404 instead of falling through
        // to the SPA index.html (which would be HTML and CORS-blocked).
        if (assetPath === "/version.json") {
          return jsonNotFound(hostname);
        }
      }

      // SPA fallback: serve index.html for all other routes
      const indexRes = await fetch(`${env.dashboard}/index.html?_=${Date.now()}`);
      const headers = new Headers(indexRes.headers);
      headers.set("Cache-Control", "no-cache");
      headers.set("Content-Type", "text/html; charset=utf-8");
      headers.set("X-Cadmus-Worker", "1");
      applySecurityHeaders(headers, { allowFraming: false, hostname });
      return new Response(indexRes.body, { status: 200, headers });
    }

    // Serve admin SPA from GCS for /admin paths
    if (isAdminRequest(hostname, url.pathname)) {
      const assetPath = url.pathname.replace(/^\/admin/, "") || "/";

      // If it looks like a static asset, fetch it directly
      if (assetPath.match(/\.\w+$/)) {
        const res = await fetch(`${env.admin}${assetPath}`);
        if (res.ok) {
          const headers = new Headers(res.headers);
          headers.set("Cache-Control", assetPath.startsWith("/assets/")
            ? "public, max-age=31536000, immutable"
            : "no-cache");
          // Monitoring page fetches version.json across environments — allow CORS.
          if (assetPath === "/version.json") {
            headers.set("Access-Control-Allow-Origin", "*");
            headers.set("Cache-Control", "no-store");
          }
          applySecurityHeaders(headers, { allowFraming: false, hostname });
          return new Response(res.body, { status: res.status, headers });
        }
        if (assetPath === "/version.json") {
          return jsonNotFound(hostname);
        }
      }

      // SPA fallback: serve index.html for all other /admin routes
      const indexRes = await fetch(`${env.admin}/index.html?_=${Date.now()}`);
      const headers = new Headers(indexRes.headers);
      headers.set("Cache-Control", "no-cache");
      headers.set("Content-Type", "text/html; charset=utf-8");
      applySecurityHeaders(headers, { allowFraming: false, hostname });
      return new Response(indexRes.body, { status: 200, headers });
    }

    // Pick the right Cloud Run origin
    const origin = isApiRequest(hostname) ? env.api : env.web;

    // Rewrite to Cloud Run origin
    url.hostname = origin;

    // Build headers separately so we don't mutate after construction, which
    // can prevent Cloudflare from streaming large request bodies (file uploads).
    const upstreamHeaders = new Headers(request.headers);
    upstreamHeaders.set("Host", origin);
    upstreamHeaders.set("X-Forwarded-Host", getForwardedHost(hostname, env));

    const newRequest = new Request(url, {
      method: request.method,
      headers: upstreamHeaders,
      body: request.body,
      redirect: "manual",
    });

    let response;
    try {
      response = await fetch(newRequest);
    } catch (err) {
      return new Response(JSON.stringify({ error: "Upstream connection failed" }), {
        status: 502,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }
    const headers = new Headers(response.headers);
    headers.set("X-Cadmus-Worker", "1");
    // Ensure CORS headers survive on API responses — Cloud Run's infrastructure
    // can return 413/502 before Hono runs, stripping our CORS middleware output.
    if (isApiRequest(hostname)) {
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Access-Control-Expose-Headers", "Content-Disposition");
    }

    // Cache HTML at the edge for 5 minutes; skip caching for error responses
    const contentType = headers.get("Content-Type") || "";
    if (contentType.includes("text/html")) {
      if (response.status === 200) {
        headers.set("Cache-Control", "public, s-maxage=300");
      } else {
        headers.set("Cache-Control", "no-store, must-revalidate");
      }
    }

    // API never gets iframed; public sites stay framable so the admin preview
    // iframe can still render them.
    applySecurityHeaders(headers, { allowFraming: !isApiRequest(hostname), hostname });

    return new Response(response.body, { status: response.status, headers });
  },
};
