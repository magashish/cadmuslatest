import type { APIRoute } from "astro";
import { listAllPublishedContent } from "../lib/api";
import { publicOrigin } from "../lib/origin";

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatLastmod(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

export const GET: APIRoute = async ({ request, locals }) => {
  const origin = publicOrigin(request);
  const siteId = locals.siteId;

  if (!siteId) {
    return new Response("Site not found", { status: 404 });
  }

  const [pages, posts] = await Promise.all([
    listAllPublishedContent(siteId, "page").catch(() => []),
    listAllPublishedContent(siteId, "post").catch(() => []),
  ]);

  const entries: Array<{ loc: string; lastmod: string | null }> = [];
  const home = pages.find((p) => p.slug === "home");
  entries.push({
    loc: `${origin}/`,
    lastmod: formatLastmod(home?.updatedAt ?? home?.publishedAt ?? null),
  });

  for (const p of pages) {
    if (p.slug === "home") continue;
    entries.push({
      loc: `${origin}/${p.slug}`,
      lastmod: formatLastmod(p.updatedAt ?? p.publishedAt),
    });
  }

  if (posts.length > 0) {
    const latestPost = posts.reduce<string | null>((acc, p) => {
      const t = p.updatedAt ?? p.publishedAt;
      if (!t) return acc;
      return !acc || t > acc ? t : acc;
    }, null);
    entries.push({ loc: `${origin}/blog`, lastmod: formatLastmod(latestPost) });

    for (const p of posts) {
      entries.push({
        loc: `${origin}/blog/${p.slug}`,
        lastmod: formatLastmod(p.updatedAt ?? p.publishedAt),
      });
    }
  }

  const urlNodes = entries
    .map((e) => {
      const lastmod = e.lastmod ? `\n    <lastmod>${e.lastmod}</lastmod>` : "";
      return `  <url>\n    <loc>${escapeXml(e.loc)}</loc>${lastmod}\n  </url>`;
    })
    .join("\n");

  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urlNodes}\n</urlset>\n`;

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=900, s-maxage=900",
    },
  });
};
