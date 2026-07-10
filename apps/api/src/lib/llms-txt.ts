import type { SiteBrief } from "@cadmus/shared";
import { getBaseDomain, getSiteUrl } from "./urls.js";

// Generates an `llms.txt` document (https://llmstxt.org) — a curated markdown
// guide that helps LLMs understand a site. Built deterministically from the
// stored site brief + published pages/posts, with an optional AI-authored
// summary. Only safe, public brief fields are emitted; `constraints` and
// `rawBrief` (internal AI-editing guidance) are never included.

export interface LlmsContentItem {
  slug: string;
  schemaData?: unknown;
}

export interface BuildLlmsTxtInput {
  siteName: string;
  origin: string; // canonical site origin, e.g. https://example.com (no trailing slash)
  brief?: SiteBrief | null;
  pages: LlmsContentItem[];
  posts: LlmsContentItem[];
  /** Overrides the deterministic summary (used by the "Write with AI" path). */
  summary?: string;
  /** Cap on posts listed, newest-first ordering assumed from the caller. */
  maxPosts?: number;
}

function oneLine(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

function prettifySlug(slug: string): string {
  return slug
    .replace(/[/_-]+/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase())
    .trim();
}

function schemaOf(item: LlmsContentItem): Record<string, unknown> {
  return (item.schemaData as Record<string, unknown> | null | undefined) ?? {};
}

function titleOf(item: LlmsContentItem, fallbackSlug: string): string {
  const t = oneLine(schemaOf(item).title);
  return t || prettifySlug(fallbackSlug);
}

function descOf(item: LlmsContentItem): string {
  const sd = schemaOf(item);
  return oneLine(sd.metaDescription) || oneLine(sd.excerpt);
}

function linkLine(title: string, url: string, desc: string): string {
  return desc ? `- [${title}](${url}): ${desc}` : `- [${title}](${url})`;
}

export function buildLlmsTxt(input: BuildLlmsTxtInput): string {
  const { origin, brief, pages, posts } = input;
  const maxPosts = input.maxPosts ?? 50;
  const siteName = oneLine(input.siteName) || oneLine(brief?.businessName) || "This site";

  const summary =
    oneLine(input.summary) ||
    oneLine(brief?.businessDescription) ||
    `${siteName} — official website.`;

  const out: string[] = [`# ${siteName}`, "", `> ${summary}`];

  // Optional context lines drawn only from safe, public brief fields.
  const details: string[] = [];
  if (brief?.targetAudience) details.push(`Audience: ${oneLine(brief.targetAudience)}`);
  if (brief?.location) details.push(`Location: ${oneLine(brief.location)}`);
  if (brief?.primaryGoal) details.push(`Primary goal: ${oneLine(brief.primaryGoal)}`);
  if (brief?.differentiators) details.push(oneLine(brief.differentiators));
  if (details.length > 0) {
    out.push("", details.join("\n"));
  }

  // Pages — home first, then the rest.
  if (pages.length > 0) {
    const home = pages.find((p) => p.slug === "home");
    const rest = pages.filter((p) => p.slug !== "home");
    const pageLines: string[] = [];
    if (home) {
      pageLines.push(linkLine(titleOf(home, "Home"), `${origin}/`, descOf(home)));
    }
    for (const p of rest) {
      pageLines.push(linkLine(titleOf(p, p.slug), `${origin}/${p.slug}`, descOf(p)));
    }
    if (pageLines.length > 0) {
      out.push("", "## Pages", "", pageLines.join("\n"));
    }
  }

  // Posts — capped; the blog index links the full archive.
  if (posts.length > 0) {
    const postLines = posts
      .slice(0, maxPosts)
      .map((p) => linkLine(titleOf(p, p.slug), `${origin}/blog/${p.slug}`, descOf(p)));
    const lines = [`- [Blog](${origin}/blog)`, ...postLines];
    out.push("", "## Posts", "", lines.join("\n"));
  }

  return out.join("\n") + "\n";
}

/**
 * Canonical public origin for a site: its active custom domain when present,
 * otherwise the platform subdomain. Delegates to getSiteUrl so the dev host
 * form ({subdomain}--dev.cadmus.digital) is honored — NOT {subdomain}.{base}.
 */
export function canonicalOrigin(
  site: { subdomain: string; domain?: string | null; domainStatus?: string | null },
  fallbackHost?: string,
): string {
  const baseDomain = getBaseDomain();
  if (site.domain && (site.domainStatus === "active" || site.domain === baseDomain)) {
    return `https://${site.domain}`;
  }
  if (site.subdomain) {
    return getSiteUrl(site.subdomain, baseDomain);
  }
  if (fallbackHost) return `https://${fallbackHost}`;
  return `https://${baseDomain}`;
}
