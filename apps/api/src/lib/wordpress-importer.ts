import sax from "sax";
import { safeFetch } from "./safe-fetch.js";
import { sanitizeSvg } from "./sanitize-html-block.js";
import { eq, and, inArray } from "drizzle-orm";
import { db, importJobs, content, contentBlocks, collections, contentCollections, media, auditLog } from "@cadmus/db";
import type { StorageProvider } from "@cadmus/cloud";

const SKIP_POST_TYPES = new Set(["nav_menu_item", "revision", "wp_block", "custom_css"]);
const IMPORT_POST_TYPES = new Set(["post", "page", "attachment"]);

interface WpCategory {
  name: string;
  slug: string;
  postCount: number;
}

interface WpTag {
  name: string;
  slug: string;
}

interface WpAuthor {
  login: string;
  displayName: string;
}

interface WpItem {
  title: string;
  slug: string;
  postType: string;
  status: string;
  creator: string;
  content: string;
  publishedAt: string | null;
  categories: Array<{ name: string; slug: string; domain: string }>;
  attachmentUrl: string | null;
}

export interface AnalyzeResult {
  postCount: number;
  pageCount: number;
  attachmentCount: number;
  authors: WpAuthor[];
  categories: WpCategory[];
  tags: WpTag[];
  hasMedia: boolean;
  parsedData: ParsedWxr;
}

export interface ParsedWxr {
  authors: WpAuthor[];
  categories: WpCategory[];
  tags: WpTag[];
  items: WpItem[];
  baseSiteUrl: string;
}

export interface ImportOptions {
  importDrafts: boolean;
  importMedia: boolean;
  authorMap: Record<string, string>;
  categoryMap: Record<string, "new" | string>;
  includePostTypes: ("post" | "page")[];
}

interface ImportResult {
  imported: { posts: number; pages: number; media: number };
  skipped: number;
  renamedSlugs: Array<{ originalSlug: string; newSlug: string; title: string }>;
  mediaErrors: Array<{ url: string; reason: string }>;
  otherErrors: string[];
}

// Parse a WXR XML buffer — streaming with sax
export async function parseWxr(xmlBuffer: Buffer): Promise<ParsedWxr> {
  return new Promise((resolve, reject) => {
    const parser = sax.parser(true, { trim: true, normalize: false });

    const authors: WpAuthor[] = [];
    const categoriesMap = new Map<string, WpCategory>();
    const tagsMap = new Map<string, WpTag>();
    const items: WpItem[] = [];
    let baseSiteUrl = "";

    // Current element tracking
    let currentTag = "";
    let currentItem: Partial<WpItem> | null = null;
    let currentAuthor: Partial<WpAuthor> | null = null;
    let inChannel = false;
    let captureText = false;
    let textBuffer = "";
    let currentCategoryDomain = "";
    let currentCategoryNicename = "";

    // Channel-level category/tag definitions (from <wp:category> and <wp:tag> elements)
    let currentWpCategory: { name?: string; slug?: string } | null = null;
    let currentWpTag: { name?: string; slug?: string } | null = null;

    parser.onopentag = (node) => {
      currentTag = node.name;
      captureText = false;

      if (node.name === "channel") {
        inChannel = true;
        return;
      }

      if (inChannel && !currentItem) {
        if (node.name === "wp:author") {
          currentAuthor = {};
          return;
        }
        if (node.name === "wp:category") {
          currentWpCategory = {};
          return;
        }
        if (node.name === "wp:tag") {
          currentWpTag = {};
          return;
        }
        if (node.name === "item") {
          currentItem = {
            title: "",
            slug: "",
            postType: "",
            status: "",
            creator: "",
            content: "",
            publishedAt: null,
            categories: [],
            attachmentUrl: null,
          };
          return;
        }
        if (node.name === "wp:base_site_url") {
          captureText = true;
          textBuffer = "";
          return;
        }
      }

      if (currentAuthor) {
        if (["wp:author_login", "wp:author_display_name"].includes(node.name)) {
          captureText = true;
          textBuffer = "";
        }
        return;
      }

      if (currentWpCategory) {
        if (["wp:cat_name", "wp:category_nicename"].includes(node.name)) {
          captureText = true;
          textBuffer = "";
        }
        return;
      }

      if (currentWpTag) {
        if (["wp:tag_name", "wp:tag_slug"].includes(node.name)) {
          captureText = true;
          textBuffer = "";
        }
        return;
      }

      if (currentItem) {
        if (node.name === "category") {
          currentCategoryDomain = (node.attributes["domain"] as string) || "";
          currentCategoryNicename = (node.attributes["nicename"] as string) || "";
          captureText = true;
          textBuffer = "";
          return;
        }

        const captureFields = [
          "title", "dc:creator", "content:encoded",
          "wp:post_name", "wp:status", "wp:post_type",
          "wp:post_date_gmt", "wp:attachment_url",
        ];
        if (captureFields.includes(node.name)) {
          captureText = true;
          textBuffer = "";
        }
      }
    };

    parser.ontext = (text) => {
      if (captureText) {
        textBuffer += text;
      }
    };

    parser.oncdata = (cdata) => {
      if (captureText) {
        textBuffer += cdata;
      }
    };

    parser.onclosetag = (name) => {
      if (name === "wp:base_site_url" && !currentItem && !currentAuthor) {
        baseSiteUrl = textBuffer.trim();
        captureText = false;
        return;
      }

      if (currentAuthor) {
        if (name === "wp:author_login") {
          currentAuthor.login = textBuffer.trim();
        } else if (name === "wp:author_display_name") {
          currentAuthor.displayName = textBuffer.trim();
        } else if (name === "wp:author") {
          if (currentAuthor.login) {
            authors.push({ login: currentAuthor.login, displayName: currentAuthor.displayName || currentAuthor.login });
          }
          currentAuthor = null;
        }
        captureText = false;
        return;
      }

      if (currentWpCategory) {
        if (name === "wp:cat_name") {
          currentWpCategory.name = textBuffer.trim();
        } else if (name === "wp:category_nicename") {
          currentWpCategory.slug = textBuffer.trim();
        } else if (name === "wp:category") {
          if (currentWpCategory.slug) {
            if (!categoriesMap.has(currentWpCategory.slug)) {
              categoriesMap.set(currentWpCategory.slug, {
                name: currentWpCategory.name || currentWpCategory.slug,
                slug: currentWpCategory.slug,
                postCount: 0,
              });
            }
          }
          currentWpCategory = null;
        }
        captureText = false;
        return;
      }

      if (currentWpTag) {
        if (name === "wp:tag_name") {
          currentWpTag.name = textBuffer.trim();
        } else if (name === "wp:tag_slug") {
          currentWpTag.slug = textBuffer.trim();
        } else if (name === "wp:tag") {
          if (currentWpTag.slug) {
            tagsMap.set(currentWpTag.slug, {
              name: currentWpTag.name || currentWpTag.slug,
              slug: currentWpTag.slug,
            });
          }
          currentWpTag = null;
        }
        captureText = false;
        return;
      }

      if (currentItem) {
        switch (name) {
          case "title":
            currentItem.title = textBuffer.trim();
            break;
          case "dc:creator":
            currentItem.creator = textBuffer.trim();
            break;
          case "content:encoded":
            currentItem.content = textBuffer;
            break;
          case "wp:post_name":
            currentItem.slug = textBuffer.trim();
            break;
          case "wp:status":
            currentItem.status = textBuffer.trim();
            break;
          case "wp:post_type":
            currentItem.postType = textBuffer.trim();
            break;
          case "wp:post_date_gmt":
            currentItem.publishedAt = textBuffer.trim() || null;
            break;
          case "wp:attachment_url":
            currentItem.attachmentUrl = textBuffer.trim() || null;
            break;
          case "category":
            if (captureText && currentCategoryDomain) {
              currentItem.categories = currentItem.categories || [];
              currentItem.categories.push({
                name: textBuffer.trim(),
                slug: currentCategoryNicename,
                domain: currentCategoryDomain,
              });
              if (currentCategoryDomain === "category" && currentCategoryNicename) {
                const existing = categoriesMap.get(currentCategoryNicename);
                if (existing) {
                  existing.postCount++;
                } else {
                  categoriesMap.set(currentCategoryNicename, {
                    name: textBuffer.trim(),
                    slug: currentCategoryNicename,
                    postCount: 1,
                  });
                }
              }
            }
            break;
          case "item": {
            const postType = currentItem.postType || "";
            if (IMPORT_POST_TYPES.has(postType) && !SKIP_POST_TYPES.has(postType)) {
              items.push(currentItem as WpItem);
            }
            currentItem = null;
            break;
          }
        }
        captureText = false;
        return;
      }

      captureText = false;
      currentTag = "";
    };

    parser.onerror = (err) => {
      reject(err);
    };

    parser.onend = () => {
      resolve({
        authors,
        categories: Array.from(categoriesMap.values()),
        tags: Array.from(tagsMap.values()),
        items,
        baseSiteUrl,
      });
    };

    parser.write(xmlBuffer.toString("utf8")).close();
  });
}

function stripGutenbergComments(html: string): string {
  return html.replace(/<!-- \/?wp:[^>]* ?-->/g, "");
}

function convertShortcodes(html: string): string {
  // [caption ...] ... [/caption] → <figure>inner</figure>
  html = html.replace(/\[caption[^\]]*\]([\s\S]*?)\[\/caption\]/gi, (_, inner) => {
    const imgMatch = inner.match(/<img[^>]*>/i);
    const img = imgMatch ? imgMatch[0] : "";
    const caption = inner.replace(/<img[^>]*>/i, "").trim();
    if (caption) {
      return `<figure>${img}<figcaption>${caption}</figcaption></figure>`;
    }
    return `<figure>${img}</figure>`;
  });

  // [embed]URL[/embed] or [embed src="URL"] → <a href="URL">URL</a>
  html = html.replace(/\[embed(?:\s+src="([^"]+)")?\]([\s\S]*?)\[\/embed\]/gi, (_, srcAttr, inner) => {
    const url = (srcAttr || inner).trim();
    return `<a href="${url}">${url}</a>`;
  });

  // Wrapping shortcodes: [foo ...]content[/foo] → keep content
  html = html.replace(/\[[a-z_-][a-z0-9_-]*[^\]]*\]([\s\S]*?)\[\/[a-z_-][a-z0-9_-]*\]/gi, (_, inner) => inner);

  // Self-closing / standalone shortcodes: [foo ...] or [foo] → remove entirely
  html = html.replace(/\[[a-z_-][a-z0-9_-]*[^\]]*\/?]/gi, "");

  return html;
}

function convertContent(rawHtml: string): string {
  let html = stripGutenbergComments(rawHtml);
  html = convertShortcodes(html);
  return html.trim();
}

async function deduplicateSlug(siteId: string, baseSlug: string, existingSlugs: Set<string>): Promise<string> {
  if (!existingSlugs.has(baseSlug)) {
    existingSlugs.add(baseSlug);
    return baseSlug;
  }
  let n = 2;
  while (existingSlugs.has(`${baseSlug}-${n}`)) {
    n++;
  }
  const newSlug = `${baseSlug}-${n}`;
  existingSlugs.add(newSlug);
  return newSlug;
}

async function loadExistingSlugs(siteId: string): Promise<Set<string>> {
  const rows = await db
    .select({ slug: content.slug })
    .from(content)
    .where(eq(content.siteId, siteId));
  return new Set(rows.map((r) => r.slug));
}

async function updateJobProgress(jobId: string, progress: number, total: number) {
  await db
    .update(importJobs)
    .set({ progress, total, updatedAt: new Date() })
    .where(eq(importJobs.id, jobId));
}

export async function runImport(
  jobId: string,
  siteId: string,
  parsedData: ParsedWxr,
  options: ImportOptions,
  uploadedBy: string,
  storage: StorageProvider | null,
): Promise<void> {
  const result: ImportResult = {
    imported: { posts: 0, pages: 0, media: 0 },
    skipped: 0,
    renamedSlugs: [],
    mediaErrors: [],
    otherErrors: [],
  };

  try {
    const statuses = new Set(["publish"]);
    if (options.importDrafts) statuses.add("draft");

    const contentItems = parsedData.items.filter(
      (item) =>
        options.includePostTypes.includes(item.postType as "post" | "page") &&
        statuses.has(item.status),
    );

    const attachmentItems = options.importMedia
      ? parsedData.items.filter((item) => item.postType === "attachment" && item.attachmentUrl)
      : [];

    const total = contentItems.length + attachmentItems.length;

    await db
      .update(importJobs)
      .set({ status: "running", total, updatedAt: new Date() })
      .where(eq(importJobs.id, jobId));

    const existingSlugs = await loadExistingSlugs(siteId);

    // Build collection ID map: wpCategorySlug → cadmus collection id
    const existingCollectionSlugs = await db
      .select({ slug: collections.slug })
      .from(collections)
      .where(eq(collections.siteId, siteId))
      .then((rows) => new Set(rows.map((r) => r.slug)));

    const uniqueCollectionSlug = (base: string): string => {
      if (!existingCollectionSlugs.has(base)) return base;
      let n = 2;
      while (existingCollectionSlugs.has(`${base}-${n}`)) n++;
      return `${base}-${n}`;
    };

    const collectionIdMap = new Map<string, string>();
    for (const [wpSlug, mapValue] of Object.entries(options.categoryMap)) {
      if (mapValue === "new") {
        const wpCat = parsedData.categories.find((c) => c.slug === wpSlug);
        if (!wpCat) continue;
        const slug = uniqueCollectionSlug(wpCat.slug);
        const [created] = await db
          .insert(collections)
          .values({
            siteId,
            type: "category",
            name: wpCat.name,
            slug,
          })
          .returning({ id: collections.id });
        existingCollectionSlugs.add(slug); // prevent collisions within same import
        collectionIdMap.set(wpSlug, created.id);
      } else {
        collectionIdMap.set(wpSlug, mapValue);
      }
    }

    // Media import: download from WP → upload to GCS → create media records
    // Build a mapping from original WP URL → new GCS URL for content rewriting
    const mediaUrlMap = new Map<string, string>();

    let progress = 0;

    for (const attachment of attachmentItems) {
      try {
        const url = attachment.attachmentUrl!;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30_000);

        let fetchRes: Response;
        try {
          fetchRes = await safeFetch(url, { signal: controller.signal });
        } finally {
          clearTimeout(timeout);
        }

        if (!fetchRes.ok) {
          result.mediaErrors.push({ url, reason: `HTTP ${fetchRes.status}` });
          continue;
        }

        const contentType = fetchRes.headers.get("content-type") || "application/octet-stream";
        const arrayBuffer = await fetchRes.arrayBuffer();
        let buf = Buffer.from(arrayBuffer);
        // SVGs land on the public bucket and can run script when opened directly.
        if (contentType.includes("image/svg+xml")) {
          buf = Buffer.from(sanitizeSvg(buf.toString("utf8")), "utf8");
        }

        const urlPath = new URL(url).pathname;
        const filename = urlPath.split("/").pop() || `media-${Date.now()}`;
        const storagePath = `sites/${siteId}/media/${Date.now()}-${filename}`;
        const uploadResult = await storage!.upload(buf, storagePath, contentType, "public, max-age=604800");

        const [mediaRecord] = await db
          .insert(media)
          .values({
            siteId,
            filename,
            storageUrl: uploadResult.url,
            mimeType: contentType,
            variants: {},
            uploadedBy,
          })
          .returning({ id: media.id, storageUrl: media.storageUrl });

        mediaUrlMap.set(url, mediaRecord.storageUrl);
        result.imported.media++;

        console.log(`[import] Media imported: ${url} → ${mediaRecord.storageUrl}`);
      } catch (err) {
        const url = attachment.attachmentUrl!;
        const reason = err instanceof Error ? err.message : String(err);
        result.mediaErrors.push({ url, reason });
        console.error(`[import] Media error for ${url}:`, reason);
      }

      progress++;
      if (progress % 5 === 0) {
        await updateJobProgress(jobId, progress, total);
      }
    }

    // Content items
    for (const item of contentItems) {
      try {
        const originalSlug = item.slug || slugify(item.title);
        const finalSlug = await deduplicateSlug(siteId, originalSlug, existingSlugs);

        if (finalSlug !== originalSlug) {
          result.renamedSlugs.push({ originalSlug, newSlug: finalSlug, title: item.title });
        }

        let htmlContent = convertContent(item.content);

        // Rewrite image URLs if media was imported
        if (mediaUrlMap.size > 0 && parsedData.baseSiteUrl) {
          for (const [oldUrl, newUrl] of mediaUrlMap) {
            htmlContent = htmlContent.split(oldUrl).join(newUrl);
          }
        }

        const cadmusStatus = item.status === "publish" ? "published" : "draft";
        const publishedAt = cadmusStatus === "published" && item.publishedAt
          ? new Date(item.publishedAt)
          : null;

        const authorId = options.authorMap[item.creator];
        const resolvedAuthorId = authorId === "owner" || !authorId ? uploadedBy : authorId;

        const [contentRecord] = await db
          .insert(content)
          .values({
            siteId,
            type: item.postType as "post" | "page",
            slug: finalSlug,
            status: cadmusStatus,
            schemaData: { title: item.title, metaDescription: "" },
            createdBy: resolvedAuthorId,
            publishedAt,
          })
          .returning({ id: content.id });

        await db.insert(contentBlocks).values({
          contentId: contentRecord.id,
          position: 0,
          blockType: "html",
          data: { html: htmlContent },
        });

        // Link to collections
        const catSlugs = item.categories
          .filter((c) => c.domain === "category")
          .map((c) => c.slug);
        for (const catSlug of catSlugs) {
          const collectionId = collectionIdMap.get(catSlug);
          if (collectionId) {
            await db.insert(contentCollections).values({
              contentId: contentRecord.id,
              collectionId,
            }).onConflictDoNothing();
          }
        }

        await db.insert(auditLog).values({
          siteId,
          actorType: "user",
          actorId: uploadedBy,
          action: "content.imported",
          entityType: "content",
          entityId: contentRecord.id,
          details: { source: "wordpress", slug: finalSlug, originalSlug, type: item.postType },
        });

        if (item.postType === "post") result.imported.posts++;
        else result.imported.pages++;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        result.otherErrors.push(`${item.title}: ${reason}`);
        console.error(`[import] Error importing "${item.title}":`, reason);
      }

      progress++;
      if (progress % 5 === 0) {
        await updateJobProgress(jobId, progress, total);
      }
    }

    result.skipped = parsedData.items.length - contentItems.length - attachmentItems.length;

    await db
      .update(importJobs)
      .set({
        status: "completed",
        progress: total,
        total,
        result,
        updatedAt: new Date(),
      })
      .where(eq(importJobs.id, jobId));

    console.log(`[import] Job ${jobId} completed:`, JSON.stringify(result.imported));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[import] Job ${jobId} failed:`, message);
    await db
      .update(importJobs)
      .set({
        status: "failed",
        result: { error: message },
        updatedAt: new Date(),
      })
      .where(eq(importJobs.id, jobId));
  }
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100) || "untitled";
}
