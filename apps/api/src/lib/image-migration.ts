import type { StorageProvider } from "@cadmus/cloud";
import type { HtmlBlockEditableField } from "@cadmus/shared";
import { optimizeImage } from "./image-optimization.js";
import { safeFetch } from "./safe-fetch.js";
import { sanitizeSvg } from "./sanitize-html-block.js";

export interface ImageMigrationResult {
  originalUrl: string;
  newUrl: string;
  filename: string;
  mimeType: string;
  altText: string;
  success: boolean;
}

const OUR_STORAGE_DOMAIN = "storage.googleapis.com/cadmus-84-media";

const USER_MEDIA_CACHE = "public, max-age=604800";

// Placeholder services — skip these so the imagePrompts extractor can replace
// them with real Imagen-generated images later. Migrating a placehold.co URL
// would upload a gray placeholder SVG to GCS and then the imagePrompts check
// (`!src.includes("placehold.co")`) would skip Imagen generation entirely.
const PLACEHOLDER_DOMAINS = ["placehold.co", "via.placeholder.com", "dummyimage.com", "placeholder.com"];

function isExternalImageUrl(url: string): boolean {
  if (!url || !url.startsWith("http")) return false;
  if (url.includes(OUR_STORAGE_DOMAIN)) return false;
  if (PLACEHOLDER_DOMAINS.some((d) => url.includes(d))) return false;
  return true;
}

function extractFilename(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const lastSegment = pathname.split("/").pop() || "";
    // Clean up and truncate long filenames
    const clean = lastSegment.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 80);
    return clean || "image.jpg";
  } catch {
    return "image.jpg";
  }
}

async function downloadAndUpload(
  url: string,
  siteId: string,
  storage: StorageProvider,
): Promise<{ newUrl: string; filename: string; mimeType: string }> {
  const res = await safeFetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download image: ${res.status} ${res.statusText}`);
  }

  const rawBuffer = Buffer.from(await res.arrayBuffer());
  const rawMime = res.headers.get("content-type") || "image/jpeg";

  // Optimize images during migration
  const isImage = rawMime.startsWith("image/") && rawMime !== "image/svg+xml";
  const isSvg = rawMime === "image/svg+xml";
  const optimized = isImage
    ? await optimizeImage(rawBuffer, rawMime, { maxWidth: 1920 })
    : isSvg
      ? { buffer: Buffer.from(sanitizeSvg(rawBuffer.toString("utf8")), "utf8"), mimeType: rawMime }
      : { buffer: rawBuffer, mimeType: rawMime };

  let filename = `${Date.now()}-${extractFilename(url)}`;
  if (isImage && optimized.mimeType !== rawMime) {
    const newExt = optimized.mimeType === "image/webp" ? ".webp" : optimized.mimeType === "image/jpeg" ? ".jpg" : "";
    if (newExt) filename = filename.replace(/\.[^.]+$/, newExt);
  }
  const path = `sites/${siteId}/media/${filename}`;

  const result = await storage.upload(optimized.buffer, path, optimized.mimeType, USER_MEDIA_CACHE);

  return { newUrl: result.url, filename, mimeType: optimized.mimeType };
}

/**
 * Download external images in HTML, upload to our storage, and rewrite URLs.
 * Non-fatal: if any single image fails, the original URL is kept.
 */
export async function migrateExternalImages(
  html: string,
  editableFields: Record<string, HtmlBlockEditableField>,
  siteId: string,
  storage: StorageProvider,
): Promise<{
  html: string;
  editableFields: Record<string, HtmlBlockEditableField>;
  results: ImageMigrationResult[];
}> {
  // Find all image src URLs and alt text in the HTML
  const imgRegex = /<img[^>]*>/g;
  const urlAlts = new Map<string, string>(); // url -> alt text
  let match;
  while ((match = imgRegex.exec(html)) !== null) {
    const tag = match[0];
    const srcMatch = tag.match(/src="([^"]+)"/);
    if (!srcMatch || !isExternalImageUrl(srcMatch[1])) continue;
    const url = srcMatch[1];
    if (!urlAlts.has(url)) {
      const altMatch = tag.match(/alt="([^"]*)"/);
      urlAlts.set(url, altMatch?.[1] || "");
    }
  }

  // Also check editableFields for image type fields
  for (const field of Object.values(editableFields)) {
    if (field.type === "image" && isExternalImageUrl(field.value)) {
      if (!urlAlts.has(field.value)) {
        urlAlts.set(field.value, field.label || "");
      }
    }
  }

  if (urlAlts.size === 0) {
    return { html, editableFields, results: [] };
  }

  // Download and upload each unique URL
  const urlMap = new Map<string, string>(); // originalUrl -> newUrl
  const results: ImageMigrationResult[] = [];

  for (const [url, altText] of urlAlts) {
    try {
      const { newUrl, filename, mimeType } = await downloadAndUpload(url, siteId, storage);
      urlMap.set(url, newUrl);
      results.push({ originalUrl: url, newUrl, filename, mimeType, altText, success: true });
    } catch (err) {
      console.warn(`Image migration failed for ${url}:`, err);
      results.push({ originalUrl: url, newUrl: url, filename: "", mimeType: "", altText, success: false });
    }
  }

  // Replace URLs in HTML
  let updatedHtml = html;
  for (const [original, replacement] of urlMap) {
    // Replace all occurrences (same image may appear multiple times)
    while (updatedHtml.includes(original)) {
      updatedHtml = updatedHtml.replace(original, replacement);
    }
  }

  // Replace URLs in editableFields
  const updatedFields = { ...editableFields };
  for (const [fieldId, field] of Object.entries(updatedFields)) {
    if (field.type === "image" && urlMap.has(field.value)) {
      updatedFields[fieldId] = { ...field, value: urlMap.get(field.value)! };
    }
  }

  return { html: updatedHtml, editableFields: updatedFields, results };
}
