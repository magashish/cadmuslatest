/**
 * Structured data (JSON-LD) helpers for SEO.
 *
 * Convention: the Organization node uses `@id: "{siteUrl}#org"` so that
 * Article, WebPage, and other schemas can reference it without repeating
 * the full object.
 */

interface BusinessInfo {
  contactEmail?: string;
  contactPhone?: string;
  streetAddress?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

interface SocialLink {
  platform: string;
  url: string;
}

// ── Organization ────────────────────────────────────────────────────────────

export function buildOrgSchema(opts: {
  siteName: string;
  siteUrl?: string;
  logoUrl?: string;
  description?: string;
  businessInfo?: BusinessInfo;
  socialLinks?: SocialLink[];
}): Record<string, unknown> {
  const org: Record<string, unknown> = {
    "@type": "Organization",
    "@id": opts.siteUrl ? `${opts.siteUrl}#org` : undefined,
    name: opts.siteName,
  };
  if (opts.siteUrl) org.url = opts.siteUrl;
  if (opts.logoUrl) org.logo = opts.logoUrl;
  if (opts.description) org.description = opts.description;

  const bi = opts.businessInfo;
  if (bi?.contactEmail || bi?.contactPhone) {
    org.contactPoint = {
      "@type": "ContactPoint",
      ...(bi.contactEmail && { email: bi.contactEmail }),
      ...(bi.contactPhone && { telephone: bi.contactPhone }),
    };
  }
  if (bi?.streetAddress || bi?.city || bi?.country) {
    org.address = {
      "@type": "PostalAddress",
      ...(bi.streetAddress && { streetAddress: bi.streetAddress }),
      ...(bi.city && { addressLocality: bi.city }),
      ...(bi.state && { addressRegion: bi.state }),
      ...(bi.postalCode && { postalCode: bi.postalCode }),
      ...(bi.country && { addressCountry: bi.country }),
    };
  }
  if (opts.socialLinks?.length) {
    org.sameAs = opts.socialLinks.map((l) => l.url).filter(Boolean);
  }

  return org;
}

// ── Org reference (for use in other schemas) ────────────────────────────────

export function orgRef(siteUrl?: string): Record<string, unknown> {
  return siteUrl
    ? { "@type": "Organization", "@id": `${siteUrl}#org` }
    : {};
}

// ── WebPage ─────────────────────────────────────────────────────────────────

export function buildWebPageSchema(opts: {
  title: string;
  description?: string;
  url: string;
  siteUrl?: string;
}): Record<string, unknown> {
  return {
    "@type": "WebPage",
    name: opts.title,
    ...(opts.description && { description: opts.description }),
    url: opts.url,
    ...(opts.siteUrl && { isPartOf: { "@type": "WebSite", "@id": `${opts.siteUrl}#org` } }),
  };
}

// ── Article (blog posts) ────────────────────────────────────────────────────

export function buildArticleSchema(opts: {
  title: string;
  description?: string;
  url: string;
  featuredImage?: string;
  authorName?: string;
  publishedAt?: string | null;
  siteUrl?: string;
  siteName: string;
  logoUrl?: string;
}): Record<string, unknown> {
  return {
    "@type": "Article",
    headline: opts.title,
    ...(opts.description && { description: opts.description }),
    url: opts.url,
    ...(opts.featuredImage && { image: opts.featuredImage }),
    ...(opts.authorName && {
      author: { "@type": "Person", name: opts.authorName },
    }),
    ...(opts.publishedAt && { datePublished: opts.publishedAt }),
    publisher: opts.siteUrl
      ? orgRef(opts.siteUrl)
      : { "@type": "Organization", name: opts.siteName, ...(opts.logoUrl && { logo: opts.logoUrl }) },
  };
}

// ── Wrap multiple schemas into a @graph ──────────────────────────────────────

export function wrapGraph(schemas: Record<string, unknown>[]): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@graph": schemas,
  };
}
