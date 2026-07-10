export const API_BASE = import.meta.env.PUBLIC_API_URL || process.env.PUBLIC_API_URL || "http://localhost:3001";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function apiFetch<T>(path: string, siteId: string): Promise<T> {
  if (!siteId || !UUID_RE.test(siteId)) {
    throw new Error(`apiFetch called with invalid siteId: ${JSON.stringify(siteId)}`);
  }
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "x-site-id": siteId },
  });
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export interface SiteInfo {
  id: string;
  name: string;
  subdomain: string;
  domain: string | null;
  plan: string; // "free" | "monthly" | "annual"
  settings: Record<string, unknown>;
  brief?: Record<string, unknown>;
  // Active add-ons projected to their public config subset (secrets stripped).
  addons?: { slug: string; config: Record<string, unknown> }[];
}

export interface ContentItem {
  id: string;
  siteId: string;
  type: string;
  slug: string;
  status: string;
  schemaData: Record<string, unknown>;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContentBlock {
  id: string;
  contentId: string;
  position: number;
  blockType: string;
  data: Record<string, unknown>;
}

export interface ContentWithBlocks extends ContentItem {
  blocks: ContentBlock[];
  authorName?: string;
}

export interface NavItem {
  label: string;
  url: string;
  children?: NavItem[];
}

export interface NavigationRecord {
  id: string;
  siteId: string;
  location: string;
  items: NavItem[];
}

export async function getSite(siteId: string): Promise<SiteInfo> {
  return apiFetch<SiteInfo>("/api/public/site", siteId);
}

export async function getContent(
  siteId: string,
  type?: string
): Promise<{ items: ContentItem[]; total: number }> {
  const params = type ? `?type=${encodeURIComponent(type)}` : "";
  return apiFetch(`/api/public/content${params}`, siteId);
}

/**
 * Paginate through every published item of a given type. Capped at 5000
 * entries so a runaway site can't generate an unbounded sitemap.
 */
export async function listAllPublishedContent(
  siteId: string,
  type: string,
): Promise<ContentItem[]> {
  const limit = 100;
  const maxEntries = 5000;
  const out: ContentItem[] = [];
  let offset = 0;
  while (out.length < maxEntries) {
    const page = await apiFetch<{ items: ContentItem[]; total: number }>(
      `/api/public/content?type=${encodeURIComponent(type)}&limit=${limit}&offset=${offset}`,
      siteId,
    ).catch(() => ({ items: [] as ContentItem[], total: 0 }));
    out.push(...page.items);
    if (page.items.length < limit) break;
    offset += page.items.length;
  }
  return out.slice(0, maxEntries);
}

export async function getContentBySlug(
  siteId: string,
  slug: string
): Promise<ContentWithBlocks> {
  return apiFetch<ContentWithBlocks>(
    `/api/public/content/${encodeURIComponent(slug)}`,
    siteId
  );
}

export async function getPreview(
  token: string,
  siteId: string
): Promise<ContentWithBlocks> {
  return apiFetch<ContentWithBlocks>(
    `/api/public/preview/${encodeURIComponent(token)}`,
    siteId
  );
}

export async function getNavigation(
  siteId: string,
  location?: string
): Promise<{ items: NavigationRecord[] }> {
  const params = location ? `?location=${encodeURIComponent(location)}` : "";
  return apiFetch(`/api/public/navigation${params}`, siteId);
}

export interface SiteNavData {
  headerNav: NavItem[];
  footerNav: NavItem[];
  headerNavConfigured: boolean;
  footerNavConfigured: boolean;
}

/**
 * Fetch both header and footer navigation in a single call.
 * `*Configured` is true when a nav record exists for that location — even if
 * the user has removed all items. This lets callers suppress Stitch placeholder
 * links once the user has taken ownership of navigation.
 */
export async function getAllNavigation(siteId: string): Promise<SiteNavData> {
  const result = await getNavigation(siteId).catch(() => ({ items: [] }));
  const headerRecord = result.items.find((r) => r.location === "header");
  const footerRecord = result.items.find((r) => r.location === "footer");
  return {
    headerNav: headerRecord?.items ?? [],
    footerNav: footerRecord?.items ?? [],
    headerNavConfigured: !!headerRecord,
    footerNavConfigured: !!footerRecord,
  };
}
