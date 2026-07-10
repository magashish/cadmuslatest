import { Hono } from "hono";
import { eq, and, ne } from "drizzle-orm";
import { parse as parseHtml } from "node-html-parser";
import type { HTMLElement as NHPElement } from "node-html-parser";
import { db, content, contentBlocks, contentVersions, media, auditLog, sites } from "@cadmus/db";
import { requireRole } from "../middleware/auth.js";
import { getStorageProvider } from "./media.js";
import { safeFetch } from "../lib/safe-fetch.js";
import { getAIRouter, mergeThemeDeltaExport as mergeThemeDelta } from "./ai.js";
import { convertHtmlToHtmlBlocks, enforceContrast } from "@cadmus/ai";
import { recompileSiteCss } from "../lib/theme-recompile.js";
import { enqueueJob } from "../lib/jobs.js";
import type { SiteEnv } from "../middleware/tenant.js";
import type { AuthUser, SiteTheme } from "@cadmus/shared";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BLOCKED_TAGS = new Set([
  "script", "style", "meta", "link", "base", "object", "embed", "applet", "iframe",
]);

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
const IMAGE_DOWNLOAD_TIMEOUT_MS = 10_000;
const IMAGE_CONCURRENCY = 5;
const USER_MEDIA_CACHE = "public, max-age=604800";

const SECTION_REWRITE_SYSTEM_PROMPT =
  "You are rewriting an HTML section to work within the Cadmus theme system. " +
  "Rewrite the provided HTML section using Tailwind utility classes. " +
  "Replace any hard-coded colors with these CSS variables: --color-primary, " +
  "--color-on-primary, --color-on-dark, --color-on-dark-muted, --color-bg, --color-surface, " +
  "--color-text, --color-text-muted, --color-border. " +
  "CONTRAST RULES (critical — getting these wrong makes text invisible): on a LIGHT background use " +
  "--color-text for body and --color-text-muted for secondary text; on a DARK, gradient, or image " +
  "background use --color-on-dark and --color-on-dark-muted (NEVER --color-text or --color-on-primary " +
  "there — they can be dark and will be invisible); use --color-on-primary ONLY on a background that is " +
  "the primary color itself. " +
  "Preserve ALL text content, links, and image tags exactly. " +
  "Keep semantic HTML structure. Every top-level element should be a <section>. " +
  "Output only the rewritten HTML, no explanation, no markdown fences.";

// ---------------------------------------------------------------------------
// Sanitizer
// ---------------------------------------------------------------------------

/**
 * Strip dangerous tags, event handler attributes, javascript:/data: hrefs, and
 * (optionally) hidden-text elements from a parsed document. Mutates the tree.
 */
function sanitizeTree(root: NHPElement, opts: { removeHidden?: boolean } = {}): void {
  // Remove blocked tags (and their subtree)
  for (const tag of BLOCKED_TAGS) {
    root.querySelectorAll(tag).forEach((el) => el.remove());
  }

  // Walk remaining elements
  const elements = root.querySelectorAll("*");
  for (const el of elements) {
    // Remove event handler attributes (on*)
    for (const attr of Object.keys(el.attributes)) {
      if (attr.toLowerCase().startsWith("on")) {
        el.removeAttribute(attr);
      }
    }

    // Strip javascript: and data: protocols from href / src
    const href = el.getAttribute("href");
    if (href) {
      const lower = href.trim().toLowerCase();
      if (lower.startsWith("javascript:") || lower.startsWith("data:")) {
        el.removeAttribute("href");
      }
    }
    const src = el.getAttribute("src");
    if (src) {
      const lower = src.trim().toLowerCase();
      if (lower.startsWith("javascript:") || lower.startsWith("data:")) {
        el.removeAttribute("src");
      }
    }

    // Remove hidden elements (prompt-injection guard)
    if (opts.removeHidden) {
      const styleAttr = el.getAttribute("style") || "";
      if (/display\s*:\s*none/i.test(styleAttr) || /visibility\s*:\s*hidden/i.test(styleAttr)) {
        el.remove();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Title extraction
// ---------------------------------------------------------------------------

function extractTitle(root: NHPElement, filename: string): string {
  const titleEl = root.querySelector("title");
  if (titleEl) {
    const text = titleEl.text.trim();
    if (text) return text;
  }
  // Fall back to filename without extension, humanize it
  return filename.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim() || "Imported Page";
}

// ---------------------------------------------------------------------------
// Slug generator
// ---------------------------------------------------------------------------

function titleToSlug(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80)
    .replace(/-$/, "");
}

// ---------------------------------------------------------------------------
// Image re-hosting
// ---------------------------------------------------------------------------

interface ImageResult {
  originalSrc: string;
  newUrl: string | null;
  error?: string;
}

async function reHostImage(src: string, siteId: string, userId: string | null): Promise<ImageResult> {
  const storage = getStorageProvider();
  if (!storage) return { originalSrc: src, newUrl: null, error: "No storage provider" };

  // Only absolute http/https URLs
  if (!src.startsWith("http://") && !src.startsWith("https://")) {
    return { originalSrc: src, newUrl: null, error: "Relative or data URL skipped" };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IMAGE_DOWNLOAD_TIMEOUT_MS);

    let response: Response;
    try {
      response = await safeFetch(src, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      return { originalSrc: src, newUrl: null, error: `HTTP ${response.status}` };
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) {
      return { originalSrc: src, newUrl: null, error: "Not an image content-type" };
    }

    // Stream to buffer with size cap
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    const reader = response.body?.getReader();
    if (!reader) return { originalSrc: src, newUrl: null, error: "No body" };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.length;
      if (totalBytes > MAX_IMAGE_BYTES) {
        await reader.cancel();
        return { originalSrc: src, newUrl: null, error: "Image too large (>10 MB)" };
      }
      chunks.push(value);
    }

    const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));

    // Derive extension from mime type
    const MIME_EXT: Record<string, string> = {
      "image/jpeg": "jpg",
      "image/jpg": "jpg",
      "image/png": "png",
      "image/gif": "gif",
      "image/webp": "webp",
      "image/svg+xml": "svg",
      "image/avif": "avif",
    };
    const baseMime = contentType.split(";")[0].trim();
    const ext = MIME_EXT[baseMime] || "jpg";

    const { randomUUID } = await import("crypto");
    const uuid = randomUUID();
    const storagePath = `sites/${siteId}/media/${uuid}.${ext}`;

    const uploadResult = await storage.upload(buffer, storagePath, baseMime, USER_MEDIA_CACHE);

    // Insert media row
    await db.insert(media).values({
      siteId,
      filename: `imported-${uuid}.${ext}`,
      storageUrl: uploadResult.url,
      mimeType: baseMime,
      variants: {},
      uploadedBy: userId ?? null,
      moderationStatus: "pending",
    });

    return { originalSrc: src, newUrl: uploadResult.url };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { originalSrc: src, newUrl: null, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Process all images in a parsed tree concurrently (capped at IMAGE_CONCURRENCY)
// ---------------------------------------------------------------------------

async function processImages(
  root: NHPElement,
  siteId: string,
  userId: string | null,
): Promise<{ imported: number; skipped: number }> {
  const imgs = root.querySelectorAll("img");
  const absoluteImgs = imgs.filter((img) => {
    const src = img.getAttribute("src") || "";
    return src.startsWith("http://") || src.startsWith("https://");
  });

  let imported = 0;
  let skipped = 0;

  // Process in batches of IMAGE_CONCURRENCY
  for (let i = 0; i < absoluteImgs.length; i += IMAGE_CONCURRENCY) {
    const batch = absoluteImgs.slice(i, i + IMAGE_CONCURRENCY);
    const results = await Promise.all(
      batch.map((img) => reHostImage(img.getAttribute("src")!, siteId, userId)),
    );
    for (let j = 0; j < batch.length; j++) {
      const result = results[j];
      if (result.newUrl) {
        batch[j].setAttribute("src", result.newUrl);
        imported++;
      } else {
        skipped++;
        if (result.error) {
          console.warn(`[html-import] image skipped (${result.error}): ${result.originalSrc.slice(0, 80)}`);
        }
      }
    }
  }

  return { imported, skipped };
}

// ---------------------------------------------------------------------------
// Section extraction
// ---------------------------------------------------------------------------

function extractSections(root: NHPElement): string[] {
  // Prefer <main>, fall back to <body>, then the root itself
  const contentRoot: NHPElement =
    root.querySelector("main") ??
    root.querySelector("body") ??
    root;

  // Strip header/footer/nav (don't import site chrome)
  contentRoot.querySelectorAll("header, footer, nav").forEach((el) => el.remove());

  const sections = contentRoot.querySelectorAll("section");
  if (sections.length > 0) {
    return sections.map((s) => s.outerHTML);
  }

  // No <section> elements — treat entire content as one block
  const html = contentRoot.innerHTML.trim();
  return html ? [`<section>${html}</section>`] : [];
}

// ---------------------------------------------------------------------------
// AI section rewrite
// ---------------------------------------------------------------------------

async function rewriteSectionWithAI(sectionHtml: string): Promise<string> {
  const router = getAIRouter();
  if (!router) return sectionHtml;

  try {
    const result = await router.generateText({
      task: "copywriting",
      systemPrompt: SECTION_REWRITE_SYSTEM_PROMPT,
      prompt: sectionHtml,
      maxTokens: 4096,
      temperature: 0.1,
    });

    const text = result.text?.trim();
    return text || sectionHtml;
  } catch (err) {
    console.warn("[html-import] AI rewrite failed for section, using original:", err);
    return sectionHtml;
  }
}

// ---------------------------------------------------------------------------
// Post-sanitize Claude output (lighter pass — just scripts + event handlers)
// ---------------------------------------------------------------------------

function postSanitizeHtml(html: string): string {
  const root = parseHtml(html);
  sanitizeTree(root, { removeHidden: false });
  return root.toString();
}

// ---------------------------------------------------------------------------
// Theme extraction helpers
// ---------------------------------------------------------------------------

function sanitizeExtractedHtml(html: string): string {
  const root = parseHtml(html);
  sanitizeTree(root, { removeHidden: false });
  return root.toString();
}

const THEME_EXTRACT_SYSTEM =
  "You are extracting brand design tokens from a website's HTML and CSS. " +
  "Analyze the provided content and return ONLY a valid JSON object with these exact fields:\n" +
  "{\n" +
  '  "primary": "#rrggbb",\n' +
  '  "accent": "#rrggbb",\n' +
  '  "bg": "#rrggbb",\n' +
  '  "text": "#rrggbb",\n' +
  '  "textMuted": "#rrggbb",\n' +
  '  "fontHeading": "FontName",\n' +
  '  "fontBody": "FontName"\n' +
  "}\n" +
  "primary = main brand/CTA color. accent = secondary highlight. bg = page background. " +
  "text = main body text. textMuted = secondary/muted text. " +
  "fontHeading and fontBody must be real Google Fonts names (e.g. Inter, Roboto, Montserrat). " +
  "Default to Inter if no font is identifiable. " +
  "All colors must be 6-digit hex (#rrggbb). Return ONLY the JSON, no markdown, no explanation.";

async function generateThemeForImport(
  source: string,
  headerHtml: string | null,
  footerHtml: string | null,
): Promise<SiteTheme | null> {
  const router = getAIRouter();
  if (!router) return null;

  try {
    const result = await router.generateText({
      task: "copywriting",
      systemPrompt: THEME_EXTRACT_SYSTEM,
      prompt: source.slice(0, 8000),
      maxTokens: 512,
      temperature: 0.1,
    });

    const text = result.text?.trim() || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const tokens = JSON.parse(jsonMatch[0]) as {
      primary?: string; accent?: string; bg?: string;
      text?: string; textMuted?: string;
      fontHeading?: string; fontBody?: string;
    };

    const theme: SiteTheme = {
      colors: {
        primary: tokens.primary || "#2563eb",
        accent: tokens.accent || "#f59e0b",
        bg: tokens.bg || "#ffffff",
        text: tokens.text || "#111827",
        textMuted: tokens.textMuted || "#6b7280",
      },
      fontFamilies: {
        heading: [tokens.fontHeading || "Inter", "sans-serif"],
        body: [tokens.fontBody || "Inter", "sans-serif"],
      },
      fonts: [],
      materialSymbols: false,
      borderRadius: {},
      customCss: "",
      version: 1,
    };

    if (headerHtml) theme.headerHtml = headerHtml;
    if (footerHtml) theme.footerHtml = footerHtml;

    return theme;
  } catch (err) {
    console.warn("[html-import] theme generation failed:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export const htmlImportRoutes = new Hono<SiteEnv & { Variables: { user: AuthUser } }>();

htmlImportRoutes.post("/html", requireRole("editor", "admin", "owner"), async (c) => {
  const site = c.get("site");
  const siteId = site?.siteId;
  if (!siteId) return c.json({ error: "Site context is required" }, 400);

  const user = c.get("user");

  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json({ error: "Failed to read upload. The file may be too large or malformed." }, 400);
  }

  const file = formData.get("file") as File | null;
  const pageTitleOverride = (formData.get("pageTitle") as string | null)?.trim() || null;

  // Read optional theme setup params
  const themeSetup = (formData.get("themeSetup") as "extract" | "brief" | null) || null;
  const themeBrief = (formData.get("themeBrief") as string | null)?.trim() || null;

  if (!file) return c.json({ error: "file is required" }, 400);
  if (!file.name.toLowerCase().match(/\.html?$/)) {
    return c.json({ error: "File must be an HTML file (.html or .htm)" }, 400);
  }

  const MAX_HTML_BYTES = 5 * 1024 * 1024;
  if (file.size > MAX_HTML_BYTES) {
    return c.json({ error: "File is too large. Maximum HTML size is 5 MB." }, 413);
  }

  const rawHtml = await file.text();
  const fileName = file.name;
  const userId = user.id;

  if (!getAIRouter()) return c.json({ error: "AI router not configured" }, 503);

  // convertHtmlToHtmlBlocks / the AI rewrite path make many model calls and
  // routinely exceed Cloudflare's 100s edge timeout (524). Run the import as a
  // background job and hand back a jobId the client polls (GET /api/ai/jobs/:id).
  const { jobId } = await enqueueJob({
    siteId,
    type: "import-html",
    payload: { fileName, pageTitle: pageTitleOverride, themeSetup },
    createdBy: userId,
    runner: () =>
      runHtmlImport({ siteId, userId, rawHtml, fileName, pageTitleOverride, themeSetup, themeBrief }),
  });

  return c.json({ jobId }, 202);
});

interface RunHtmlImportOpts {
  siteId: string;
  userId: string;
  rawHtml: string;
  fileName: string;
  pageTitleOverride: string | null;
  themeSetup: "extract" | "brief" | null;
  themeBrief: string | null;
}

// Heavy import work (theme extraction + per-section AI rewrite). Runs in the
// background via enqueueJob so it isn't bound by the HTTP / edge request timeout.
// Returns the result object (becomes the job's `result`); throws on failure.
async function runHtmlImport(opts: RunHtmlImportOpts) {
  const { siteId, rawHtml, pageTitleOverride, themeSetup, themeBrief } = opts;
  const user = { id: opts.userId };
  const file = { name: opts.fileName };

  // ── Stitch fast-path: if the HTML contains a Tailwind config, treat it as a
  // Stitch export and use convertHtmlToHtmlBlocks instead of the AI rewrite path.
  // This correctly extracts colors, fonts, Material Symbols, bodyClasses, etc.
  const isStitchHtml = /tailwind\.config\s*=/.test(rawHtml);
  if (isStitchHtml) {
    const router = getAIRouter();
    if (!router) throw new Error("AI router not configured");

    const [siteRow] = await db.select({ settings: sites.settings }).from(sites).where(eq(sites.id, siteId));
    const settings = (siteRow?.settings as Record<string, unknown>) ?? {};
    const currentTheme = settings.theme as SiteTheme | undefined;

    // Determine page type: home if no theme yet (first import), otherwise treat as interior page
    const pageType = currentTheme?.colors && Object.keys(currentTheme.colors).length > 0 ? "page" : "homepage";
    console.log(`[html-import] Stitch HTML detected — using convertHtmlToHtmlBlocks (pageType=${pageType})`);

    const blocksResult = await convertHtmlToHtmlBlocks(router, { html: rawHtml, pageType });
    const mergedTheme = mergeThemeDelta(currentTheme, blocksResult.themeDelta);

    if (!mergedTheme.footerHtml) {
      const year = new Date().getFullYear();
      const [siteNameRow] = await db.select({ name: sites.name }).from(sites).where(eq(sites.id, siteId));
      const name = siteNameRow?.name ?? "Site";
      mergedTheme.footerHtml = `<footer style="background:var(--color-bg);border-top:1px solid var(--color-primary);padding:2.5rem 0"><div style="max-width:72rem;margin:0 auto;padding:0 1.5rem;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:1rem"><a href="/" style="font-family:var(--font-heading);font-weight:700;color:var(--color-primary);text-decoration:none">${name}</a><span style="color:var(--color-text-muted);font-size:0.875rem">© ${year} ${name}</span></div></footer>`;
    }

    await db.update(sites).set({ settings: { ...settings, theme: mergedTheme } }).where(eq(sites.id, siteId));

    // Build page slug
    const extractedTitleStitch = pageTitleOverride || (parseHtml(rawHtml).querySelector("title")?.text || file.name.replace(/\.html?$/i, "")).trim();
    const baseSlugStitch = titleToSlug(extractedTitleStitch) || "imported-page";
    let slugStitch = baseSlugStitch;
    for (let attempt = 0; attempt <= 100; attempt++) {
      const candidate = attempt === 0 ? baseSlugStitch : `${baseSlugStitch}-${attempt}`;
      const [dup] = await db.select({ id: content.id }).from(content)
        .where(and(eq(content.siteId, siteId), eq(content.slug, candidate), eq(content.type, "page"), ne(content.status, "archived"))).limit(1);
      if (!dup) { slugStitch = candidate; break; }
      if (attempt === 100) slugStitch = `${baseSlugStitch}-${Date.now()}`;
    }

    // Contrast safety-net: fix any dark-text-on-dark-section slips before save.
    const stitchBlocks = blocksResult.blocks.map((b) => {
      const data = b.data as { html?: string } | undefined;
      return data?.html
        ? { ...b, data: { ...data, html: enforceContrast(data.html, mergedTheme) } }
        : b;
    });
    const page = await db.transaction(async (tx) => {
      const [created] = await tx.insert(content).values({
        siteId, type: "page", slug: slugStitch, status: "draft",
        schemaData: { title: extractedTitleStitch }, createdBy: user.id, publishedAt: null,
      }).returning();
      await tx.insert(contentBlocks).values(stitchBlocks.map((block, i) => ({
        contentId: created.id, position: i, blockType: block.blockType, data: block.data,
      })));
      await tx.insert(contentVersions).values({
        contentId: created.id, version: 1, schemaData: created.schemaData,
        blocksSnapshot: stitchBlocks, createdBy: user.id,
      });
      await tx.insert(auditLog).values({
        siteId, actorType: "user", actorId: user.id, action: "content.imported_stitch_html",
        entityType: "content", entityId: created.id,
        details: { title: extractedTitleStitch, slug: slugStitch, blocksImported: stitchBlocks.length, pageType },
      });
      return created;
    });

    recompileSiteCss(siteId).catch((err) => console.warn("[html-import] CSS recompile failed:", err));
    return { pageId: page.id, pageSlug: page.slug, blocksImported: stitchBlocks.length, themeCreated: pageType === "homepage" };
  }

  // ── Step 1: Extract theme material + sanitize ────────────────────────────
  const inputRoot = parseHtml(rawHtml);

  // Grab header/footer and CSS BEFORE sanitizeTree strips <style> tags and
  // removes hidden elements — we need the raw design signals for theme generation.
  const preHeaderEl = inputRoot.querySelector("header");
  const preFooterEl = inputRoot.querySelector("footer");
  const rawHeaderHtml = preHeaderEl ? sanitizeExtractedHtml(preHeaderEl.outerHTML) : null;
  const rawFooterHtml = preFooterEl ? sanitizeExtractedHtml(preFooterEl.outerHTML) : null;

  // CSS from <style> blocks + meta theme-color for AI color extraction
  const styleContent = [...rawHtml.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((m) => m[1])
    .join("\n")
    .slice(0, 4000);
  const metaThemeColor =
    rawHtml.match(/name="theme-color"[^>]*content="([^"]+)"/i)?.[1] ||
    rawHtml.match(/content="([^"]+)"[^>]*name="theme-color"/i)?.[1] ||
    "";

  sanitizeTree(inputRoot, { removeHidden: true });

  // ── Step 1b: Generate theme if requested and none exists ─────────────────
  let themeCreated = false;
  if (themeSetup) {
    const [siteRow] = await db
      .select({ settings: sites.settings })
      .from(sites)
      .where(eq(sites.id, siteId));
    const settings = (siteRow?.settings as Record<string, unknown>) ?? {};

    if (!settings.theme) {
      const themeSource =
        themeSetup === "brief" && themeBrief
          ? `Brand brief:\n${themeBrief}\n\nPage CSS:\n${styleContent}${metaThemeColor ? `\nMeta theme-color: ${metaThemeColor}` : ""}${rawHeaderHtml ? `\n\nHeader HTML:\n${rawHeaderHtml.slice(0, 2000)}` : ""}`
          : `Page CSS:\n${styleContent}${metaThemeColor ? `\nMeta theme-color: ${metaThemeColor}` : ""}${rawHeaderHtml ? `\n\nHeader HTML:\n${rawHeaderHtml.slice(0, 3000)}` : ""}`;

      const generatedTheme = await generateThemeForImport(themeSource, rawHeaderHtml, rawFooterHtml);
      if (generatedTheme) {
        await db
          .update(sites)
          .set({ settings: { ...settings, theme: generatedTheme } })
          .where(eq(sites.id, siteId));
        themeCreated = true;
      }
    }
  }

  // ── Step 2: Extract title ────────────────────────────────────────────────
  const extractedTitle = pageTitleOverride || extractTitle(inputRoot, file.name);

  // ── Step 3: Download + re-host images ───────────────────────────────────
  const { imported: imagesImported, skipped: imagesSkipped } = await processImages(
    inputRoot,
    siteId,
    user.id,
  );

  // ── Step 4: Extract sections ─────────────────────────────────────────────
  const sections = extractSections(inputRoot);

  if (sections.length === 0) {
    throw new Error("No content found in the HTML file.");
  }

  // ── Steps 5 + 6: Rewrite sections with Claude, then post-sanitize ────────
  // Process sequentially to avoid rate limits
  const rewrittenSections: string[] = [];
  for (const section of sections) {
    const rewritten = await rewriteSectionWithAI(section);
    const clean = postSanitizeHtml(rewritten);
    rewrittenSections.push(clean);
  }

  // ── Step 7: Create page ──────────────────────────────────────────────────
  const baseSlug = titleToSlug(extractedTitle) || "imported-page";

  // Ensure unique slug within this site/type
  let slug = baseSlug;
  for (let attempt = 0; attempt <= 100; attempt++) {
    const candidateSlug = attempt === 0 ? baseSlug : `${baseSlug}-${attempt}`;
    const [dup] = await db
      .select({ id: content.id })
      .from(content)
      .where(and(
        eq(content.siteId, siteId),
        eq(content.slug, candidateSlug),
        eq(content.type, "page"),
        ne(content.status, "archived"),
      ))
      .limit(1);

    if (!dup) {
      slug = candidateSlug;
      break;
    }
    if (attempt === 100) {
      slug = `${baseSlug}-${Date.now()}`;
    }
  }

  // Load the site theme so the contrast safety-net can resolve token colours,
  // then fix any dark-text-on-dark-section slips the AI rewrite made.
  const [themeRow] = await db.select({ settings: sites.settings }).from(sites).where(eq(sites.id, siteId));
  const importTheme = (((themeRow?.settings as Record<string, unknown>)?.theme) ?? {}) as SiteTheme;

  const blocks = rewrittenSections.map((html) => ({
    blockType: "html" as const,
    data: {
      html: enforceContrast(html, importTheme),
      editableFields: {} as Record<string, unknown>,
    },
  }));

  const page = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(content)
      .values({
        siteId,
        type: "page",
        slug,
        status: "draft",
        schemaData: { title: extractedTitle },
        createdBy: user.id,
        publishedAt: null,
      })
      .returning();

    await tx.insert(contentBlocks).values(
      blocks.map((block, i) => ({
        contentId: created.id,
        position: i,
        blockType: block.blockType,
        data: block.data,
      })),
    );

    await tx.insert(contentVersions).values({
      contentId: created.id,
      version: 1,
      schemaData: created.schemaData,
      blocksSnapshot: blocks,
      createdBy: user.id,
    });

    await tx.insert(auditLog).values({
      siteId,
      actorType: "user",
      actorId: user.id,
      action: "content.imported_html",
      entityType: "content",
      entityId: created.id,
      details: {
        title: extractedTitle,
        slug,
        blocksImported: blocks.length,
        imagesImported,
        imagesSkipped,
        themeCreated,
      },
    });

    return created;
  });

  // Recompile CSS now that a new page's classes are available (or theme was just created)
  recompileSiteCss(siteId).catch((err) =>
    console.warn("[html-import] CSS recompile failed:", err),
  );

  return {
    pageId: page.id,
    pageSlug: page.slug,
    blocksImported: blocks.length,
    imagesImported,
    imagesSkipped,
    themeCreated,
  };
}
