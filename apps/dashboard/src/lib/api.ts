const API_BASE = import.meta.env.VITE_API_URL || "";

function getToken(): string | null {
  return localStorage.getItem("ap_token");
}

async function apiFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };

  const token = getToken();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  // No x-site-id header — dashboard operates cross-tenant

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `API error: ${res.status}`);
  }

  return res.json();
}

// ── Auth ──────────────────────────────────────────────────────────────────────

interface UserProfile {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  role: string;
  siteId: string;
  globalRole?: string;
}

export const auth = {
  login(email: string, password: string) {
    return apiFetch<{ token: string; user: UserProfile }>(
      "/api/auth/login",
      { method: "POST", body: JSON.stringify({ email, password }) }
    );
  },

  me() {
    return apiFetch<{ user: UserProfile }>("/api/auth/me");
  },
};

// ── Admin endpoints ───────────────────────────────────────────────────────────

interface StatsResponse {
  sites: number;
  users: number;
  activeSubscriptions: number;
  trials: number;
  partners: number;
  referrals: number;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface SiteListItem {
  id: string;
  name: string;
  subdomain: string;
  domain: string | null;
  status: string;
  createdAt: string;
  subscriptionStatus: string | null;
  trialEndsAt: string | null;
  ownerEmail: string | null;
  ownerName: string | null;
}

export interface SiteDetail {
  site: {
    id: string;
    name: string;
    subdomain: string;
    domain: string | null;
    domainStatus: string | null;
    status: string;
    plan: string;
    billing: string;
    brief: Record<string, unknown> | null;
    settings: Record<string, unknown>;
    suspendedAt: string | null;
    suspensionReason: string | null;
    suspensionSource: string | null;
    archivedAt: string | null;
    archiveReason: string | null;
    hardDeleteAt: string | null;
    createdAt: string;
    updatedAt: string;
  };
  subscription: {
    id: string;
    status: string;
    stripeCustomerId: string;
    stripeSubscriptionId: string | null;
    trialStartedAt: string | null;
    trialEndsAt: string | null;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    billingUserId: string | null;
  } | null;
  team: {
    id: string;
    userId: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    role: string;
    status: string;
    joinedAt: string | null;
  }[];
  recentActivity: {
    id: string;
    actorType: string;
    actorId: string | null;
    action: string;
    entityType: string | null;
    entityId: string | null;
    details: Record<string, unknown>;
    createdAt: string;
  }[];
  counts: {
    content: number;
    media: number;
  };
}

export interface PartnerListItem {
  id: string;
  name: string;
  code: string;
  commissionRate: string | null;
  commissionsOnAddons: boolean;
  isAgency: boolean;
  status: string;
  createdAt: string;
  userId: string;
  userEmail: string;
  userName: string;
  siteCount: number;
  referralCount: number;
}

export interface PartnerDetail {
  partner: {
    id: string;
    name: string;
    code: string;
    commissionRate: string | null;
    commissionsOnAddons: boolean;
    isAgency: boolean;
    status: string;
    createdAt: string;
  };
  user: {
    id: string;
    email: string;
    name: string;
  };
  linkedSites: {
    id: string;
    name: string;
    subdomain: string;
    status: string;
    billingActive: boolean;
    linkedAt: string;
  }[];
}

export interface ReferralItem {
  id: string;
  referralCode: string;
  status: string;
  qualifiedAt: string | null;
  rewardedAt: string | null;
  createdAt: string;
  referrerEmail: string;
  referrerName: string;
  siteName: string;
  siteSubdomain: string;
  siteId: string;
  sitePlan: string;
  partnerName: string | null;
  commissionRate: string | null;
  commissionsOnAddons: boolean;
  rewardEligibleAt: string | null;
}

export interface UserListItem {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  globalRole: string;
  createdAt: string;
}

function qs(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== "");
  return entries.length ? "?" + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString() : "";
}

export interface PlatformConfigItem {
  key: string;
  value: unknown;
  description: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

export interface AiUsageRow {
  siteId: string;
  siteName: string;
  subdomain: string;
  chatMessages30d: number;
  imagesMonthly: number;
  pagesLifetime: number;
}

export interface AiUsageTotals {
  chatMessages30d: number;
  imagesMonthly: number;
  pagesLifetime: number;
}

export interface PromoItem {
  id: string;
  code: string;
  slug: string | null;
  name: string;
  type: string;
  planOverride: string | null;
  trialDays: number;
  maxRedemptions: number | null;
  redemptionCount: number;
  expiresAt: string | null;
  isActive: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PromoRedemption {
  id: string;
  siteId: string;
  siteName: string;
  subdomain: string;
  userId: string;
  userEmail: string;
  redeemedAt: string;
  ipAddress: string | null;
}

export interface AddonItem {
  id: string;
  slug: string;
  name: string;
  tagline: string | null;
  description: string | null;
  category: string | null;
  runtime: string;
  isFree: boolean;
  priceMonthlyCents: number | null;
  priceAnnualCents: number | null;
  stripeProductId: string | null;
  stripePriceMonthlyId: string | null;
  stripePriceAnnualId: string | null;
  status: string;
  sortOrder: number;
  configDefaults: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  activeInstallCount: number;
}

export interface AddonCreateInput {
  slug: string;
  name: string;
  tagline?: string | null;
  description?: string | null;
  category?: string | null;
  isFree: boolean;
  priceMonthlyCents?: number | null;
  priceAnnualCents?: number | null;
  sortOrder?: number;
  configDefaults?: Record<string, unknown>;
}

export interface AddonUpdateInput {
  name?: string;
  tagline?: string | null;
  description?: string | null;
  category?: string | null;
  isFree?: boolean;
  priceMonthlyCents?: number | null;
  priceAnnualCents?: number | null;
  status?: string;
  sortOrder?: number;
  configDefaults?: Record<string, unknown>;
}

export const admin = {
  stats() {
    return apiFetch<StatsResponse>("/api/admin/stats");
  },

  sites(params?: { page?: number; limit?: number; search?: string; status?: string }) {
    return apiFetch<{ items: SiteListItem[]; pagination: Pagination }>(
      `/api/admin/sites${qs(params || {})}`
    );
  },

  site(id: string) {
    return apiFetch<SiteDetail>(`/api/admin/sites/${id}`);
  },

  setSiteStatus(id: string, data: { status: string; reason?: string; graceDays?: number }) {
    return apiFetch<{ site: SiteDetail["site"] }>(`/api/admin/sites/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  },

  restartOnboarding(id: string) {
    return apiFetch<{ site: SiteDetail["site"] }>(`/api/admin/sites/${id}/restart-onboarding`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  },

  // Mint a short-lived handoff token so we can open a site's admin app (a
  // different origin) as the current cadmus_admin.
  siteAccess(id: string) {
    return apiFetch<{ token: string }>(`/api/admin/sites/${id}/access`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  },

  partners() {
    return apiFetch<{ items: PartnerListItem[] }>("/api/admin/partners");
  },

  createPartner(data: { email: string; name: string; code: string; commissionRate?: string; commissionsOnAddons?: boolean; isAgency?: boolean }) {
    return apiFetch<Record<string, unknown>>("/api/admin/partners", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  updatePartner(id: string, data: { name?: string; code?: string; commissionRate?: string; commissionsOnAddons?: boolean; isAgency?: boolean; status?: string }) {
    return apiFetch<Record<string, unknown>>(`/api/admin/partners/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  },

  partner(id: string) {
    return apiFetch<PartnerDetail>(`/api/admin/partners/${id}`);
  },

  setPartnerSiteBilling(partnerId: string, siteId: string, billingActive: boolean) {
    return apiFetch<{ ok: boolean; billingActive: boolean }>(
      `/api/admin/partners/${partnerId}/sites/${siteId}`,
      { method: "PATCH", body: JSON.stringify({ billingActive }) }
    );
  },

  referrals(params?: { status?: string }) {
    return apiFetch<{ items: ReferralItem[] }>(`/api/admin/referrals${qs(params || {})}`);
  },

  rewardReferral(id: string) {
    return apiFetch<{ ok: boolean; rewardedAt: string }>(`/api/admin/referrals/${id}/reward`, {
      method: "POST",
    });
  },

  users(params?: { page?: number; limit?: number; search?: string }) {
    return apiFetch<{ items: UserListItem[]; pagination: Pagination }>(
      `/api/admin/users${qs(params || {})}`
    );
  },

  platformConfig() {
    return apiFetch<{ items: PlatformConfigItem[] }>("/api/admin/platform-config");
  },

  setPlatformConfig(key: string, value: unknown) {
    return apiFetch<{ item: PlatformConfigItem }>(`/api/admin/platform-config/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    });
  },

  aiUsage() {
    return apiFetch<{ items: AiUsageRow[]; totals: AiUsageTotals }>("/api/admin/ai-usage");
  },

  overrideSite(id: string, data: { plan?: string; status?: string }) {
    return apiFetch<{ ok: boolean }>(`/api/admin/sites/${id}/override`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  },

  expireArchivesDryRun() {
    return apiFetch<{ expired: number; previews: { siteId: string; name: string; subdomain: string; hardDeleteAt: string }[] }>(
      "/api/admin/maintenance/expire-archives?dryRun=true",
      { method: "POST" }
    );
  },

  expireArchives() {
    return apiFetch<{ deleted: number; results: { siteId: string; name: string; deleted: boolean; error?: string }[] }>(
      "/api/admin/maintenance/expire-archives",
      { method: "POST" }
    );
  },

  promotions() {
    return apiFetch<{ items: PromoItem[] }>("/api/admin/promotions");
  },

  createPromotion(data: Partial<PromoItem>) {
    return apiFetch<{ item: PromoItem }>("/api/admin/promotions", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  updatePromotion(id: string, data: Partial<PromoItem>) {
    return apiFetch<{ item: PromoItem }>(`/api/admin/promotions/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  },

  deletePromotion(id: string) {
    return apiFetch<{ ok: boolean }>(`/api/admin/promotions/${id}`, { method: "DELETE" });
  },

  promotionRedemptions(id: string) {
    return apiFetch<{ items: PromoRedemption[] }>(`/api/admin/promotions/${id}/redemptions`);
  },

  addons() {
    return apiFetch<{ items: AddonItem[] }>("/api/admin/addons");
  },

  createAddon(data: AddonCreateInput) {
    return apiFetch<{ item: AddonItem }>("/api/admin/addons", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  updateAddon(id: string, data: AddonUpdateInput) {
    return apiFetch<{ item: AddonItem }>(`/api/admin/addons/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  },

  deleteAddon(id: string) {
    return apiFetch<{ ok: boolean }>(`/api/admin/addons/${id}`, { method: "DELETE" });
  },

  expirePromos(dryRun = false) {
    return apiFetch<{ expired: number; results?: { siteId: string; name: string }[]; previews?: { id: string; name: string; subdomain: string }[] }>(
      `/api/admin/maintenance/expire-promos${dryRun ? "?dryRun=true" : ""}`,
      { method: "POST" }
    );
  },

  logs(params: { service: string; severity?: string; q?: string; sinceMinutes?: number; limit?: number; cursor?: string }) {
    return apiFetch<{ entries: LogEntryItem[]; nextCursor?: string }>(`/api/admin/logs${qs(params)}`);
  },
};

export interface LogEntryItem {
  timestamp: string;
  severity: string;
  service: string;
  message: string;
  trace?: string;
  httpRequest?: {
    requestUrl?: string;
    remoteIp?: string;
    userAgent?: string;
  };
}

// ── Sentry ────────────────────────────────────────────────────────────────────

export interface SentryIssue {
  id: string;
  title: string;
  project: string;
  lastSeen: string;
  count: number;
  level: string;
  permalink: string;
}

export interface SentryAlertsResponse {
  issues: SentryIssue[];
  cachedAt: string;
  nextRefreshAt: string;
  environment: string;
}

export const sentryApi = {
  issues() {
    return apiFetch<SentryAlertsResponse>("/api/admin/sentry/issues");
  },
};

// ── Media Review ─────────────────────────────────────────────────────────────

export interface MediaReviewItem {
  id: string;
  filename: string;
  storageUrl: string;
  mimeType: string;
  moderationStatus: string;
  moderationScores: Record<string, string>;
  moderationReason: string | null;
  moderationSource: string | null;
  blockedAt: string | null;
  stagingPath: string | null;
  siteId: string;
  siteName: string;
  createdAt: string;
}

export const mediaReview = {
  list(status = "review") {
    return apiFetch<{ items: MediaReviewItem[]; total: number }>(`/api/admin/media-review?status=${status}`);
  },
  streamUrl(id: string) {
    return apiFetch<{ url: string }>(`/api/admin/media-review/${id}/stream`);
  },
  approve(id: string) {
    return apiFetch<{ ok: boolean }>(`/api/admin/media-review/${id}/approve`, { method: "POST" });
  },
  block(id: string, reason?: string) {
    return apiFetch<{ ok: boolean }>(`/api/admin/media-review/${id}/block`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    });
  },
  setStatus(id: string, status: string, reason?: string) {
    return apiFetch<{ ok: boolean }>(`/api/admin/media-review/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status, reason }),
    });
  },
  deleteItem(id: string) {
    return apiFetch<{ ok: boolean }>(`/api/admin/media-review/${id}`, {
      method: "DELETE",
    });
  },
};

// ── Support ───────────────────────────────────────────────────────────────────

export interface SupportTicket {
  id: string;
  siteId: string;
  userId: string;
  siteName: string;
  userEmail: string;
  type: "support" | "feature_request";
  subject: string;
  body: string;
  status: "open" | "in_progress" | "resolved" | "closed";
  priority: "low" | "normal" | "high";
  createdAt: string;
  updatedAt: string;
}

export interface TicketComment {
  id: string;
  ticketId: string;
  authorId: string;
  authorEmail: string;
  authorName: string;
  body: string;
  isInternal: boolean;
  createdAt: string;
}

export const support = {
  tickets(params?: { status?: string; type?: string; limit?: number; offset?: number }) {
    return apiFetch<{ tickets: SupportTicket[]; total: number }>(
      `/api/support/tickets${qs(params || {})}`
    );
  },

  update(id: string, data: { status?: string; priority?: string }) {
    return apiFetch<{ ticket: SupportTicket }>(`/api/support/tickets/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  },

  comments(ticketId: string) {
    return apiFetch<{ comments: TicketComment[] }>(`/api/support/tickets/${ticketId}/comments`);
  },

  addComment(ticketId: string, data: { body: string; isInternal?: boolean }) {
    return apiFetch<{ comment: TicketComment }>(`/api/support/tickets/${ticketId}/comments`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  getSettings() {
    return apiFetch<{ settings: Record<string, string> }>("/api/support/settings");
  },

  saveSettings(settings: Record<string, string>) {
    return apiFetch<{ ok: boolean }>("/api/support/settings", {
      method: "PUT",
      body: JSON.stringify(settings),
    });
  },
};
