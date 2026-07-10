import { Hono } from "hono";
import { eq, desc } from "drizzle-orm";
import {
  db,
  sites,
  content,
  contentBlocks,
  collections,
  contentCollections,
  navigation,
  media,
  formSubmissions,
} from "@cadmus/db";
import type { SiteEnv } from "../middleware/tenant.js";
import type { SiteTheme } from "@cadmus/shared";
import { themeToTailwindConfig } from "@cadmus/shared";
import archiver from "archiver";
import { PassThrough } from "node:stream";

export const exportRoutes = new Hono<SiteEnv>();

// ---------------------------------------------------------------------------
// GET /api/export?format=json&categories=content,submissions,settings,collections,navigation,media
// GET /api/export?format=html
// ---------------------------------------------------------------------------

exportRoutes.get("/", async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) {
    return c.json({ error: "Site context is required" }, 400);
  }

  const format = c.req.query("format") || "json";

  if (format === "html") {
    return exportHtml(c, siteId);
  }

  // JSON export — pick categories
  const categoriesParam = c.req.query("categories") || "all";
  const allCategories = ["content", "submissions", "settings", "collections", "navigation", "media"];
  const categories =
    categoriesParam === "all"
      ? allCategories
      : categoriesParam.split(",").filter((cat) => allCategories.includes(cat));

  const result: Record<string, unknown> = {
    exportedAt: new Date().toISOString(),
    format: "cadmus-json-v1",
    siteId,
  };

  // Fetch in parallel
  const fetches: Promise<void>[] = [];

  if (categories.includes("settings")) {
    fetches.push(
      (async () => {
        const [site] = await db
          .select({
            name: sites.name,
            subdomain: sites.subdomain,
            domain: sites.domain,
            brief: sites.brief,
            settings: sites.settings,
          })
          .from(sites)
          .where(eq(sites.id, siteId));
        result.site = site || null;
      })()
    );
  }

  if (categories.includes("content")) {
    fetches.push(
      (async () => {
        const items = await db
          .select()
          .from(content)
          .where(eq(content.siteId, siteId))
          .orderBy(desc(content.updatedAt));

        const contentWithBlocks = await Promise.all(
          items.map(async (item) => {
            const blocks = await db
              .select()
              .from(contentBlocks)
              .where(eq(contentBlocks.contentId, item.id))
              .orderBy(contentBlocks.position);
            return { ...item, blocks };
          })
        );
        result.content = contentWithBlocks;
      })()
    );
  }

  if (categories.includes("submissions")) {
    fetches.push(
      (async () => {
        try {
          const items = await db
            .select()
            .from(formSubmissions)
            .where(eq(formSubmissions.siteId, siteId))
            .orderBy(desc(formSubmissions.createdAt));
          result.formSubmissions = items;
        } catch {
          result.formSubmissions = [];
        }
      })()
    );
  }

  if (categories.includes("collections")) {
    fetches.push(
      (async () => {
        const items = await db
          .select()
          .from(collections)
          .where(eq(collections.siteId, siteId));
        const mappings = items.length > 0
          ? await db.select().from(contentCollections)
          : [];
        result.collections = items;
        result.contentCollections = mappings;
      })()
    );
  }

  if (categories.includes("navigation")) {
    fetches.push(
      (async () => {
        const items = await db
          .select()
          .from(navigation)
          .where(eq(navigation.siteId, siteId));
        result.navigation = items;
      })()
    );
  }

  if (categories.includes("media")) {
    fetches.push(
      (async () => {
        const items = await db
          .select()
          .from(media)
          .where(eq(media.siteId, siteId))
          .orderBy(desc(media.createdAt));
        result.media = items;
      })()
    );
  }

  await Promise.all(fetches);

  const json = JSON.stringify(result, null, 2);
  const [site] = await db
    .select({ subdomain: sites.subdomain })
    .from(sites)
    .where(eq(sites.id, siteId));
  const filename = `${site?.subdomain || "cadmus"}-export-${new Date().toISOString().slice(0, 10)}.json`;

  return new Response(json, {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
});

// ---------------------------------------------------------------------------
// HTML export — one HTML file per page, zipped together, matching live site
// ---------------------------------------------------------------------------

async function exportHtml(c: any, siteId: string) {
  const [site] = await db
    .select()
    .from(sites)
    .where(eq(sites.id, siteId));

  if (!site) {
    return c.json({ error: "Site not found" }, 404);
  }

  // Fetch all content with blocks
  const items = await db
    .select()
    .from(content)
    .where(eq(content.siteId, siteId))
    .orderBy(content.slug);

  const pages = await Promise.all(
    items.map(async (item) => {
      const blocks = await db
        .select()
        .from(contentBlocks)
        .where(eq(contentBlocks.contentId, item.id))
        .orderBy(contentBlocks.position);
      return { ...item, blocks };
    })
  );

  // Extract site theme
  const settings = (site.settings ?? {}) as Record<string, unknown>;
  const theme = settings.theme as SiteTheme | undefined;
  const siteName = site.name || "Cadmus Site";

  // Build the shared <head> content
  const headContent = buildHeadContent(theme);

  // Create zip archive
  const archive = archiver("zip", { zlib: { level: 9 } });
  const passthrough = new PassThrough();
  archive.pipe(passthrough);

  // Generate one HTML file per page
  for (const page of pages) {
    const pageTitle = (page.schemaData as Record<string, unknown>)?.title || page.slug;
    const filename = page.slug === "home" ? "index.html" : `${page.slug}.html`;

    const blocksHtml = page.blocks
      .map((block) => renderBlockToHtml(block))
      .join("\n");

    const hasStitchBlocks = page.blocks.some((b) => b.blockType === "html");

    const html = buildPageHtml({
      title: String(pageTitle),
      siteName,
      headContent,
      bodyContent: blocksHtml,
      theme,
      hasStitchBlocks,
    });

    archive.append(html, { name: filename });
  }

  archive.finalize();

  // Collect the stream into a buffer
  const chunks: Buffer[] = [];
  for await (const chunk of passthrough) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const zipBuffer = Buffer.concat(chunks);

  const zipFilename = `${site.subdomain || "cadmus"}-export-${new Date().toISOString().slice(0, 10)}.zip`;

  return new Response(zipBuffer, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${zipFilename}"`,
    },
  });
}

// ---------------------------------------------------------------------------
// Page HTML builder — mirrors BaseLayout.astro structure
// ---------------------------------------------------------------------------

function buildPageHtml(opts: {
  title: string;
  siteName: string;
  headContent: string;
  bodyContent: string;
  theme?: SiteTheme;
  hasStitchBlocks: boolean;
}): string {
  const { title, siteName, headContent, bodyContent, theme, hasStitchBlocks } = opts;
  const hasStitch = !!theme && hasStitchBlocks;

  // Tailwind config driven by the SiteTheme tokens
  const tailwindConfig = hasStitch ? JSON.stringify(themeToTailwindConfig(theme!)) : "";

  const headerHtml = hasStitch ? theme!.headerHtml ?? "" : "";
  const footerHtml = hasStitch ? theme!.footerHtml ?? "" : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} | ${escapeHtml(siteName)}</title>
  ${hasStitch ? `<script src="https://cdn.tailwindcss.com"><\/script>` : ""}
  ${hasStitch ? `<script>tailwind.config = ${tailwindConfig};<\/script>` : ""}
  ${headContent}
  <style>
    body {
      margin: 0;
      font-family: system-ui, -apple-system, sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      line-height: 1.6;
    }
    main {
      flex: 1;
      ${hasStitch ? "padding: 0;" : "max-width: 1200px; margin: 0 auto; padding: 2rem 1rem;"}
    }
    ${hasStitch ? "main.stitch-main { max-width: none; isolation: isolate; }" : ""}
    .block-text { max-width: 800px; margin: 1rem auto; padding: 0 1rem; }
    .block-heading { max-width: 800px; margin: 1.5rem auto 0.5rem; padding: 0 1rem; }
  </style>
</head>
<body${hasStitch ? ' class="stitch-site"' : ""}>
  ${headerHtml}
  <main${hasStitch ? ' class="stitch-main"' : ""}>
    ${bodyContent}
  </main>
  ${footerHtml}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Head content builder — fonts, icons, custom CSS
// ---------------------------------------------------------------------------

function buildHeadContent(theme?: SiteTheme): string {
  if (!theme) return "";

  const parts: string[] = [];

  // Google Fonts (use the font URLs from the theme, same as BaseLayout)
  if (theme.fonts?.length) {
    parts.push('<link rel="preconnect" href="https://fonts.googleapis.com">');
    parts.push('<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>');
    for (const fontUrl of theme.fonts) {
      parts.push(`<link rel="stylesheet" href="${fontUrl}">`);
    }
  }

  // Material Symbols
  if (theme.materialSymbols) {
    parts.push('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200">');
  }

  // Custom CSS
  if (theme.customCss) {
    parts.push(`<style>${theme.customCss}</style>`);
  }

  return parts.join("\n  ");
}

// ---------------------------------------------------------------------------
// Block renderer — uses raw HTML for Stitch blocks, basic markup for others
// ---------------------------------------------------------------------------

function renderBlockToHtml(block: { blockType: string; data: unknown }): string {
  const data = (block.data ?? {}) as Record<string, unknown>;

  switch (block.blockType) {
    case "html":
      // Stitch blocks: use the raw HTML exactly as stored, preserving design
      return `<div class="stitch-section">${data.html || ""}</div>${data.css ? `<style>${data.css}</style>` : ""}`;

    case "hero":
      return `<div class="block-text">
        <h1>${escapeHtml(String(data.headline || ""))}</h1>
        ${data.subheadline ? `<p>${escapeHtml(String(data.subheadline))}</p>` : ""}
        ${data.ctaText ? `<p><strong>${escapeHtml(String(data.ctaText))}</strong></p>` : ""}
      </div>`;

    case "text":
      return `<div class="block-text">${data.body || data.content || ""}</div>`;

    case "heading": {
      const level = data.level || 2;
      return `<div class="block-heading"><h${level}>${escapeHtml(String(data.text || ""))}</h${level}></div>`;
    }

    case "image":
      return `<div class="block-text">
        ${data.src ? `<img src="${escapeAttr(String(data.src))}" alt="${escapeAttr(String(data.alt || ""))}" style="max-width:100%">` : ""}
        ${data.caption ? `<p><em>${escapeHtml(String(data.caption))}</em></p>` : ""}
      </div>`;

    case "cta":
      return `<div class="block-text" style="text-align:center;padding:2rem 0">
        ${data.headline ? `<h2>${escapeHtml(String(data.headline))}</h2>` : ""}
        ${data.body ? `<p>${escapeHtml(String(data.body))}</p>` : ""}
        ${data.buttonText ? `<p><strong>${escapeHtml(String(data.buttonText))}</strong></p>` : ""}
      </div>`;

    case "faq": {
      const items = (data.items || []) as Array<{ question: string; answer: string }>;
      const faqHtml = items
        .map((item) => `<dt>${escapeHtml(item.question)}</dt><dd>${escapeHtml(item.answer)}</dd>`)
        .join("");
      return `<div class="block-text"><dl>${faqHtml}</dl></div>`;
    }

    case "testimonial": {
      const testimonials = (data.items || []) as Array<{ quote: string; author: string; role?: string }>;
      return `<div class="block-text">${testimonials
        .map((t) => `<blockquote><p>${escapeHtml(t.quote)}</p><cite>— ${escapeHtml(t.author)}${t.role ? `, ${escapeHtml(t.role)}` : ""}</cite></blockquote>`)
        .join("")}</div>`;
    }

    case "form": {
      const fields = (data.fields || []) as Array<{ name: string; label: string; type: string }>;
      const fieldsHtml = fields
        .map((f) => `<p><label>${escapeHtml(f.label)}: <input type="${f.type === "textarea" ? "text" : f.type}" name="${escapeAttr(f.name)}" placeholder="${escapeAttr(f.label)}"></label></p>`)
        .join("");
      return `<div class="block-text"><form>${fieldsHtml}<p><button type="submit">${escapeHtml(String(data.submitText || "Submit"))}</button></p></form></div>`;
    }

    default: {
      const textFields = ["body", "content", "text", "description"];
      for (const field of textFields) {
        if (data[field]) {
          return `<div class="block-text">${escapeHtml(String(data[field]))}</div>`;
        }
      }
      return "";
    }
  }
}

// ---------------------------------------------------------------------------
// Escape helpers
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
