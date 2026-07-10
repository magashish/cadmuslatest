const BASE_DOMAIN = import.meta.env.BASE_DOMAIN || process.env.BASE_DOMAIN || "cadmus.digital";

/**
 * The canonical PUBLIC origin for the current request.
 *
 * On dev, the Cloudflare worker (scripts/cloudflare-worker.js) forwards an
 * INTERNAL host for tenant resolution — it rewrites the public
 * `{sub}--dev.cadmus.digital` to `{sub}.dev.cadmus.digital` before hitting the
 * web app. Reading x-forwarded-host directly therefore yields an unreachable
 * dotted host. This reverses that mapping so emitted URLs (sitemap <loc>,
 * robots Sitemap:) point at the host visitors actually use. Mirrors
 * getSiteHost() in apps/api/src/lib/urls.ts.
 *
 * Prod is a no-op ({sub}.cadmus.digital in → same out); custom domains pass
 * through unchanged.
 */
export function publicOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get("x-forwarded-host") || url.host;

  // Public sites are always served over HTTPS (TLS terminates at Cloudflare),
  // but the request reaching Cloud Run is plain HTTP — so url.protocol can't be
  // trusted. Force https except for local dev.
  const isLocal = host.startsWith("localhost") || host.startsWith("127.0.0.1");
  const protocol = isLocal ? url.protocol : "https:";

  const suffix = `.${BASE_DOMAIN}`;
  if (host.endsWith(suffix)) {
    const sub = host.slice(0, -suffix.length);
    // Only the single-level tenant host is rewritten — not the apex or nested.
    if (sub && !sub.includes(".")) {
      const publicHost =
        BASE_DOMAIN === "cadmus.digital" ? `${sub}.cadmus.digital` : `${sub}--dev.cadmus.digital`;
      return `${protocol}//${publicHost}`;
    }
  }

  return `${protocol}//${host}`;
}
