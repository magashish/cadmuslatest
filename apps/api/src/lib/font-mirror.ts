/**
 * Mirror a Google Fonts CSS URL (and the woff2 files it references) into our
 * shared media bucket so we serve them ourselves instead of making visitors
 * hit fonts.googleapis.com / fonts.gstatic.com on every page load.
 *
 * Cache key is the SHA-256 of the source URL — every site that requests the
 * same Google Fonts URL gets the same mirrored CSS, so we store each font
 * file at most once across the platform.
 *
 * Returns the mirrored public URL on success, or the original URL on failure
 * so that a transient mirror miss never breaks the site.
 */

import { createHash } from "node:crypto";
import { getStorageProvider } from "../routes/media.js";

const SHARED_PREFIX = "_shared/fonts";

// Mirrored fonts are content-addressed (sha256 of source URL), so the bytes
// at any given path never change. Tell browsers to cache forever.
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

// Modern Chrome UA — Google's CSS API serves woff2 only to clients that
// advertise woff2 support, which it infers from the User-Agent.
const WOFF2_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const inFlight = new Map<string, Promise<string>>();

function hashUrl(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

async function urlExists(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Mirror a Google Fonts CSS URL. Returns a self-hosted public URL.
 *
 * - Hits the storage cache first (HEAD on the predicted public URL).
 * - On miss: fetches the source CSS, mirrors every gstatic woff2 it references
 *   (also hash-keyed, so font files dedupe across CSS bundles), rewrites the
 *   CSS, and stores it.
 * - Concurrent calls for the same URL share one in-flight promise.
 * - Any error returns the original URL so the page still renders (against
 *   Google directly) instead of crashing.
 */
export async function mirrorGoogleFontsCss(sourceUrl: string): Promise<string> {
  if (!/^https:\/\/fonts\.googleapis\.com\//.test(sourceUrl)) return sourceUrl;

  const storage = getStorageProvider();
  if (!storage) return sourceUrl;

  const existing = inFlight.get(sourceUrl);
  if (existing) return existing;

  const promise = (async () => {
    const cssHash = hashUrl(sourceUrl);
    const cssPath = `${SHARED_PREFIX}/css/${cssHash}.css`;
    const publicUrl = storage.getPublicUrl(cssPath);

    if (await urlExists(publicUrl)) return publicUrl;

    const cssRes = await fetch(sourceUrl, { headers: { "User-Agent": WOFF2_UA } });
    if (!cssRes.ok) throw new Error(`Source CSS fetch ${cssRes.status}`);
    const cssText = await cssRes.text();

    const woff2Urls = new Set<string>();
    const urlRe = /url\((https:\/\/fonts\.gstatic\.com\/[^)\s'"]+)\)/g;
    for (const m of cssText.matchAll(urlRe)) woff2Urls.add(m[1]);

    const urlMap = new Map<string, string>();
    await Promise.all(
      [...woff2Urls].map(async (woff2Url) => {
        const fileHash = hashUrl(woff2Url);
        const ext = woff2Url.match(/\.(woff2|woff|ttf|otf)(?:\?|$)/i)?.[1] ?? "woff2";
        const filePath = `${SHARED_PREFIX}/files/${fileHash}.${ext}`;
        const fileUrl = storage.getPublicUrl(filePath);
        urlMap.set(woff2Url, fileUrl);

        if (await urlExists(fileUrl)) return;

        const fileRes = await fetch(woff2Url, { headers: { "User-Agent": WOFF2_UA } });
        if (!fileRes.ok) throw new Error(`Font file fetch ${fileRes.status} for ${woff2Url}`);
        const buf = Buffer.from(await fileRes.arrayBuffer());
        await storage.upload(buf, filePath, `font/${ext}`, IMMUTABLE_CACHE);
      }),
    );

    let rewritten = cssText;
    for (const [from, to] of urlMap) {
      rewritten = rewritten.split(from).join(to);
    }

    await storage.upload(Buffer.from(rewritten, "utf8"), cssPath, "text/css; charset=utf-8", IMMUTABLE_CACHE);
    return publicUrl;
  })().catch((err) => {
    console.warn(`[font-mirror] Failed to mirror ${sourceUrl}:`, err);
    return sourceUrl;
  });

  inFlight.set(sourceUrl, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(sourceUrl);
  }
}
