const API_BASE = import.meta.env.VITE_API_URL || "";

let currentSiteId: string | null = null;

export function setSiteId(id: string | null) {
  currentSiteId = id;
}

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

  if (currentSiteId) {
    headers["x-site-id"] = currentSiteId;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new ApiError(body.error || `API error: ${res.status}`, res.status);
    throw err;
  }

  return res.json();
}

/** Error thrown by apiFetch carrying the HTTP status so callers can distinguish
 *  an auth failure (401) from a transient network/server error. */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** True when a rejection is a fetch abort (navigation/unmount), not a real
 *  failure. Firefox reports these as `NS_ERROR_ABORT`; Chromium as AbortError. */
export function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  const name = (err as { name?: string } | null)?.name;
  const message = (err as { message?: string } | null)?.message ?? "";
  return name === "AbortError" || /NS_ERROR_ABORT|aborted/i.test(message);
}

interface ChatActionPayload {
  type: string;
  status: "success" | "error";
  result?: Record<string, unknown>;
  error?: string;
  historyId?: string;
}

export interface ChatDonePayload {
  turnId: string;
  text: string;
  actions: ChatActionPayload[];
  model: string;
  usedFallback: boolean;
}

export type ChatStreamEvent =
  | { event: "start"; data: { turnId: string } }
  | { event: "text"; data: { text: string } }
  | { event: "tool_start"; data: { name: string; toolUseId: string } }
  | { event: "action"; data: { action: ChatActionPayload } }
  | { event: "error"; data: { error: string } }
  | { event: "done"; data: ChatDonePayload };

async function streamChat(
  body: { message: string; conversationHistory?: { role: "user" | "assistant"; content: string }[]; currentPath?: string },
  onEvent?: (event: ChatStreamEvent) => void,
): Promise<ChatDonePayload> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (currentSiteId) headers["x-site-id"] = currentSiteId;

  const res = await fetch(`${API_BASE}/api/ai/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error || `API error: ${res.status}`);
  }
  if (!res.body) {
    throw new Error("Chat stream returned no body");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done: ChatDonePayload | null = null;
  let lastError: string | null = null;

  // Parse SSE: messages are separated by blank lines; each message has `event:`
  // and `data:` fields. Server emits `done` with the final summary, or `error`.
  for (;;) {
    const { value, done: streamDone } = await reader.read();
    if (streamDone) break;
    buffer += decoder.decode(value, { stream: true });

    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const evt = parseSseEvent(raw);
      if (!evt) continue;
      if (evt.event === "ping") continue; // keepalive — ignore
      if (evt.event === "done") {
        done = evt.data as ChatDonePayload;
      } else if (evt.event === "error") {
        lastError = (evt.data as { error?: string }).error || "Stream error";
      }
      onEvent?.(evt as ChatStreamEvent);
    }
  }

  if (done) return done;
  throw new Error(lastError || "Chat stream ended without a final response");
}

function parseSseEvent(raw: string): { event: string; data: unknown } | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    return null;
  }
}

/** Raw fetch with auth + site headers — returns the Response (for downloads, blobs, etc.) */
export async function apiRawFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (currentSiteId) headers["x-site-id"] = currentSiteId;

  return fetch(`${API_BASE}${path}`, { ...options, headers });
}

// Auth
interface SiteMembership {
  siteId: string;
  siteName: string;
  subdomain: string;
  domain: string | null;
  domainStatus: string | null;
  role: string;
  status: string;
}

interface UserProfile {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  role: string;
  siteId: string;
  globalRole?: string;
  memberships?: SiteMembership[];
  emailVerifiedAt?: string | null;
  locale?: string;
}

export const auth = {
  login(email: string, password: string, siteId?: string) {
    return apiFetch<{ token: string; user: UserProfile }>(
      "/api/auth/login",
      { method: "POST", body: JSON.stringify({ email, password, ...(siteId ? { siteId } : {}) }) }
    );
  },

  signup(email: string, password: string, name: string, promoCode?: string, referralCode?: string, clientCode?: string) {
    return apiFetch<{ token: string; user: UserProfile; promoApplied?: boolean }>(
      "/api/auth/signup",
      { method: "POST", body: JSON.stringify({ name, email, password, ...(promoCode ? { promoCode } : {}), ...(referralCode ? { referralCode } : {}), ...(clientCode ? { clientCode } : {}) }) }
    );
  },

  // Agency disclosure for ?client= signup links
  partnerInfo(code: string) {
    return apiFetch<{ valid: boolean; name?: string }>(
      `/api/promo/partner-info/${encodeURIComponent(code)}`
    );
  },

  promoInfo(code: string) {
    return apiFetch<{ valid: boolean; reason?: string; name?: string; type?: string; trialDays?: number; planOverride?: string }>(
      `/api/promo/info/${encodeURIComponent(code)}`
    );
  },

  me(signal?: AbortSignal) {
    return apiFetch<{ token?: string; user: UserProfile }>(
      "/api/auth/me",
      { signal }
    );
  },

  changePassword(currentPassword: string, newPassword: string) {
    // Server bumps tokenVersion (invalidating other sessions) and returns a
    // fresh token for THIS session — callers must persist it or get logged out.
    return apiFetch<{ ok: boolean; token?: string }>(
      "/api/auth/change-password",
      { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) }
    );
  },

  updateProfile(data: { firstName?: string; lastName?: string; locale?: string }) {
    return apiFetch<{ user: UserProfile }>(
      "/api/auth/profile",
      { method: "PUT", body: JSON.stringify(data) }
    );
  },

  switchSite(siteId: string) {
    return apiFetch<{ token: string; user: UserProfile }>(
      "/api/auth/switch-site",
      { method: "POST", body: JSON.stringify({ siteId }) }
    );
  },

  // Exchange a dashboard handoff token for a real session scoped to a site.
  handoff(token: string) {
    return apiFetch<{ token: string; user: UserProfile }>(
      "/api/auth/handoff",
      { method: "POST", body: JSON.stringify({ token }) }
    );
  },

  setSubdomain(subdomain: string) {
    return apiFetch<{ ok: boolean; subdomain: string }>(
      "/api/auth/set-subdomain",
      { method: "POST", body: JSON.stringify({ subdomain }) }
    );
  },

  checkSubdomain(subdomain: string) {
    return apiFetch<{ available: boolean; suggestion?: string }>(
      `/api/auth/check-subdomain?subdomain=${encodeURIComponent(subdomain)}`
    );
  },

  suggestSubdomain() {
    return apiFetch<{ subdomain: string }>("/api/auth/suggest-subdomain");
  },

  verifyEmail(token: string) {
    return apiFetch<{ ok: boolean }>(
      `/api/auth/verify-email?token=${encodeURIComponent(token)}`
    );
  },

  resendVerification() {
    return apiFetch<{ ok: boolean }>(
      "/api/auth/resend-verification",
      { method: "POST" }
    );
  },
};

// Content
export const content = {
  list(type?: string, status?: string) {
    const params = new URLSearchParams();
    if (type) params.set("type", type);
    if (status) params.set("status", status);
    const qs = params.toString();
    return apiFetch<{ items: unknown[]; total: number }>(
      `/api/content${qs ? `?${qs}` : ""}`
    );
  },

  get(id: string) {
    return apiFetch<unknown>(`/api/content/${id}`);
  },

  create(data: unknown) {
    return apiFetch<{ id: string; [key: string]: unknown }>("/api/content", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  update(id: string, data: unknown) {
    return apiFetch<unknown>(`/api/content/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  },

  delete(id: string, deletedBy?: string) {
    const qs = deletedBy ? `?deletedBy=${encodeURIComponent(deletedBy)}` : "";
    return apiFetch<unknown>(`/api/content/${id}${qs}`, { method: "DELETE" });
  },

  versions(id: string) {
    return apiFetch<{
      versions: Array<{
        id: string;
        contentId: string;
        version: number;
        schemaData: Record<string, unknown> | null;
        blocksSnapshot: Array<Record<string, unknown>> | null;
        createdBy: string | null;
        authorName: string | null;
        createdAt: string;
      }>;
    }>(`/api/content/${id}/versions`);
  },

  restore(id: string, version: number, restoredBy?: string) {
    return apiFetch<unknown>(`/api/content/${id}/versions/${version}/restore`, {
      method: "POST",
      body: JSON.stringify({ restoredBy }),
    });
  },

  unarchive(id: string, restoredBy?: string) {
    return apiFetch<unknown>(`/api/content/${id}/unarchive`, {
      method: "POST",
      body: JSON.stringify({ restoredBy }),
    });
  },

  previewUrl(id: string) {
    return apiFetch<{ token: string; previewUrl: string }>(`/api/content/${id}/preview`, {
      method: "POST",
    });
  },
};

// Media
export const media = {
  list(opts?: { mime?: string; excludeBlocked?: boolean; limit?: number; offset?: number }) {
    const params = new URLSearchParams();
    if (opts?.mime) params.set("mime", opts.mime);
    if (opts?.excludeBlocked) params.set("excludeBlocked", "true");
    if (opts?.limit != null) params.set("limit", String(opts.limit));
    if (opts?.offset != null) params.set("offset", String(opts.offset));
    const qs = params.toString();
    return apiFetch<{ items: unknown[]; total: number }>(
      `/api/media${qs ? `?${qs}` : ""}`
    );
  },

  usage() {
    return apiFetch<{ usedBytes: number; quotaBytes: number; fileCount: number; uploadLimitBytes: number }>(
      "/api/media/usage"
    );
  },

  get(id: string) {
    return apiFetch<unknown>(`/api/media/${id}`);
  },

  async upload(file: File, uploadedBy?: string, onProgress?: (pct: number) => void) {
    const formData = new FormData();
    formData.append("file", file);
    if (uploadedBy) formData.append("uploadedBy", uploadedBy);

    const headers: Record<string, string> = {};
    const token = getToken();
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    if (currentSiteId) {
      headers["x-site-id"] = currentSiteId;
    }

    return new Promise<unknown>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${API_BASE}/api/media/upload`);
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
      if (onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
        };
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)); } catch { resolve({}); }
        } else {
          try {
            const body = JSON.parse(xhr.responseText);
            reject(new Error(body.error || `Upload failed: ${xhr.status}`));
          } catch { reject(new Error(`Upload failed: ${xhr.status}`)); }
        }
      };
      xhr.onerror = () => reject(new Error("Upload network error"));
      xhr.send(formData);
    });
  },

  // Video/PDF uploads. Small files go through the multipart /api/media/upload
  // path (server-side upload — no signed URL, no browser→GCS CORS). Only files
  // above Cloud Run's ~32 MB request cap need the direct-to-GCS path.
  async uploadVideo(file: File, onProgress?: (pct: number) => void) {
    // Stay safely under Cloud Run's 32 MiB request limit (form overhead included).
    const DIRECT_UPLOAD_THRESHOLD = 30 * 1024 * 1024;
    if (file.size <= DIRECT_UPLOAD_THRESHOLD) {
      return media.upload(file, undefined, onProgress);
    }

    const { mediaId, uploadUrl } = await apiFetch<{
      mediaId: string;
      uploadUrl: string;
      stagingPath: string;
    }>("/api/media/upload-url", {
      method: "POST",
      body: JSON.stringify({
        filename: file.name,
        mimeType: file.type,
        fileSize: file.size,
      }),
    });

    // uploadUrl is a GCS resumable upload session. Upload the whole file in a
    // single PUT: Content-Range spanning the full size finalizes the object.
    // No auth headers — the session URI is the capability.
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", uploadUrl);
      xhr.setRequestHeader("Content-Type", file.type);
      xhr.setRequestHeader("Content-Range", `bytes 0-${file.size - 1}/${file.size}`);
      if (onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
        };
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(`Upload to storage failed: ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error("Upload network error"));
      xhr.send(file);
    });

    // Finalize: enqueues the moderation scan and returns the media item.
    return apiFetch<unknown>(`/api/media/upload-complete/${mediaId}`, {
      method: "POST",
    });
  },

  update(id: string, data: { aiAltText?: string; filename?: string; updatedBy?: string }) {
    return apiFetch<unknown>(`/api/media/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  },

  delete(id: string, deletedBy?: string) {
    const qs = deletedBy ? `?deletedBy=${encodeURIComponent(deletedBy)}` : "";
    return apiFetch<unknown>(`/api/media/${id}${qs}`, { method: "DELETE" });
  },
};

// Collections
export const collections = {
  list(type?: string) {
    const params = new URLSearchParams();
    if (type) params.set("type", type);
    const qs = params.toString();
    return apiFetch<{ items: unknown[] }>(`/api/collections${qs ? `?${qs}` : ""}`);
  },

  create(data: unknown) {
    return apiFetch<unknown>("/api/collections", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  update(id: string, data: unknown) {
    return apiFetch<unknown>(`/api/collections/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  },

  delete(id: string) {
    return apiFetch<unknown>(`/api/collections/${id}`, { method: "DELETE" });
  },

  addContent(collectionId: string, contentId: string) {
    return apiFetch<unknown>(`/api/collections/${collectionId}/content`, {
      method: "POST",
      body: JSON.stringify({ contentId }),
    });
  },

  removeContent(collectionId: string, contentId: string) {
    return apiFetch<unknown>(`/api/collections/${collectionId}/content/${contentId}`, {
      method: "DELETE",
    });
  },

  forContent(contentId: string) {
    return apiFetch<{ items: unknown[] }>(`/api/collections/by-content/${contentId}`);
  },
};

// Redirects
export const redirects = {
  list() {
    return apiFetch<{ items: unknown[] }>("/api/redirects");
  },
  create(data: { fromPath: string; toUrl: string; statusCode?: number }) {
    return apiFetch<unknown>("/api/redirects", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },
  bulkImport(rows: Array<{ fromPath: string; toUrl: string; statusCode?: number }>) {
    return apiFetch<{ created: number; skipped: number; errors: string[] }>("/api/redirects/import", {
      method: "POST",
      body: JSON.stringify({ rows }),
    });
  },
  update(id: string, data: { toUrl?: string; statusCode?: number; enabled?: boolean }) {
    return apiFetch<unknown>(`/api/redirects/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  },
  delete(id: string) {
    return apiFetch<unknown>(`/api/redirects/${id}`, { method: "DELETE" });
  },
};

// Navigation
export const navigation = {
  list(location?: string) {
    const params = new URLSearchParams();
    if (location) params.set("location", location);
    const qs = params.toString();
    return apiFetch<{ items: { id: string; location: string; items: { label: string; url: string }[] }[] }>(
      `/api/navigation${qs ? `?${qs}` : ""}`
    );
  },

  get(id: string) {
    return apiFetch<{ id: string; location: string; items: { label: string; url: string }[] }>(
      `/api/navigation/${id}`
    );
  },

  upsert(location: string, items: { label: string; url: string }[], updatedBy?: string) {
    return apiFetch<unknown>(`/api/navigation/${location}`, {
      method: "PUT",
      body: JSON.stringify({ items, updatedBy }),
    });
  },

  delete(id: string, deletedBy?: string) {
    const qs = deletedBy ? `?deletedBy=${encodeURIComponent(deletedBy)}` : "";
    return apiFetch<unknown>(`/api/navigation/${id}${qs}`, { method: "DELETE" });
  },
};

// The site's persistent design direction — mirrors @cadmus/shared's DesignIntent.
// Synthesized from the homepage, refined by the AI on global direction changes,
// and editable here by admins.
export interface DesignIntent {
  aestheticDirection: string;
  voiceAndTone: string;
  layoutPrinciples: string;
  imageryStyle: string;
  colorAndType: string;
  constraints: string[];
  positioning?: string;
  version: number;
  updatedAt: string;
  source: "generated" | "refined" | "user-edited";
}

// Sites
export const site = {
  provision(name: string, ownerEmail: string, password: string, plan?: "monthly" | "annual") {
    return apiFetch<{
      token: string;
      user: { id: string; email: string; role: string; siteId: string };
      site: { id: string; name: string; subdomain: string; status: string };
      adminUrl: string;
    }>("/api/sites", {
      method: "POST",
      body: JSON.stringify({ name, ownerEmail, password, plan }),
    });
  },

  get(id: string) {
    return apiFetch<{ id: string; name: string; subdomain: string; domain?: string; status: string; brief?: Record<string, string>; [key: string]: unknown }>(
      `/api/sites/${id}`
    );
  },

  stats(id: string) {
    return apiFetch<{
      content: { pages: number; posts: number; published: number; drafts: number };
      media: number;
      activity: { action: string; entityType: string; createdAt: string; details: Record<string, unknown> }[];
    }>(`/api/sites/${id}/stats`);
  },

  recompileCss(id: string) {
    return apiFetch<{ success: boolean }>(`/api/sites/${id}/recompile-css`, {
      method: "POST",
    });
  },

  update(id: string, data: unknown) {
    return apiFetch<unknown>(`/api/sites/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  },

  updateCustomCode(id: string, data: { head: string; bodyEnd: string }) {
    return apiFetch<{ ok: boolean }>(`/api/sites/${id}/custom-code`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  },

  getDesignIntent(id: string) {
    return apiFetch<{ designIntent: DesignIntent | null }>(`/api/sites/${id}/design-intent`);
  },

  updateDesignIntent(id: string, data: Partial<DesignIntent>) {
    return apiFetch<{ designIntent: DesignIntent }>(`/api/sites/${id}/design-intent`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  },

  activate(id: string, promoCode?: string) {
    return apiFetch<unknown>(`/api/sites/${id}/activate`, {
      method: "POST",
      body: JSON.stringify(promoCode ? { promoCode } : {}),
    });
  },

  connectDomain(id: string, domain: string) {
    return apiFetch<{
      site: unknown;
      domainStatus: string;
      isRootDomain?: boolean;
      dns: { instructions: { type: string; name: string; value: string }[]; message: string };
    }>(`/api/sites/${id}/domain`, {
      method: "POST",
      body: JSON.stringify({ domain }),
    });
  },

  getDomainStatus(id: string) {
    return apiFetch<{
      domain: string;
      domainStatus: string;
      sslStatus: string;
      errors?: string[];
    }>(`/api/sites/${id}/domain/status`);
  },

  disconnectDomain(id: string) {
    return apiFetch<{ site: unknown }>(`/api/sites/${id}/domain`, {
      method: "DELETE",
    });
  },
  reset(id: string) {
    return apiFetch<{ success: boolean }>(`/api/sites/${id}/reset`, {
      method: "POST",
    });
  },
  restartOnboarding(id: string) {
    return apiFetch<{ success: boolean }>(`/api/sites/${id}/restart-onboarding`, {
      method: "POST",
    });
  },

  changeSubdomain(subdomain: string) {
    return apiFetch<{ ok: boolean; subdomain: string }>("/api/sites/subdomain", {
      method: "PUT",
      body: JSON.stringify({ subdomain }),
    });
  },
};

export interface SeoFiles {
  indexable: boolean;
  plan: string;
  llms: { override: string | null; generated: string; url: string };
  robots: { url: string };
  sitemap: { url: string; entryCount: number };
}

export const seo = {
  get(siteId: string) {
    return apiFetch<SeoFiles>(`/api/sites/${siteId}/seo`);
  },
  // Pass a non-empty string to store an override; null/empty reverts to auto.
  saveLlms(siteId: string, llmsTxt: string | null) {
    return apiFetch<{ llmsTxt: string | null }>(`/api/sites/${siteId}/seo`, {
      method: "PUT",
      body: JSON.stringify({ llmsTxt }),
    });
  },
  draftLlms(siteId: string) {
    return apiFetch<{ draft: string }>(`/api/sites/${siteId}/seo/llms/draft`, {
      method: "POST",
    });
  },
};

// Add-ons (marketplace)
export interface MarketplaceAddon {
  id: string;
  slug: string;
  name: string;
  tagline: string | null;
  description: string | null;
  category: string | null;
  isFree: boolean;
  priceMonthlyCents: number | null;
  priceAnnualCents: number | null;
  installed: boolean;
  installStatus: "active" | "suspended" | null;
  config?: Record<string, unknown>;
}

export const addons = {
  list() {
    return apiFetch<{ items: MarketplaceAddon[] }>("/api/addons");
  },

  install(slug: string) {
    return apiFetch<{ slug: string; installed: boolean; installStatus: "active" | "suspended"; config: Record<string, unknown> }>(
      `/api/addons/${encodeURIComponent(slug)}/install`,
      { method: "POST" }
    );
  },

  uninstall(slug: string) {
    return apiFetch<{ ok: true }>(`/api/addons/${encodeURIComponent(slug)}`, {
      method: "DELETE",
    });
  },

  updateConfig(slug: string, config: Record<string, unknown>) {
    return apiFetch<{ slug: string; config: Record<string, unknown> }>(
      `/api/addons/${encodeURIComponent(slug)}/config`,
      { method: "PUT", body: JSON.stringify(config) }
    );
  },
};

// AI
export interface Insight {
  id: string;
  title: string;
  rationale: string;
  page: string | null;
  actionLabel?: string;
  prompt?: string;
}

export const ai = {
  interview(message: string, conversationHistory?: { role: "user" | "assistant"; content: string }[]) {
    return apiFetch<{ response: string; model: string; usedFallback: boolean }>(
      "/api/ai/interview",
      {
        method: "POST",
        body: JSON.stringify({ message, conversationHistory }),
      }
    );
  },

  extractBrief(conversationHistory: { role: "user" | "assistant"; content: string }[]) {
    return apiFetch<{ brief: Record<string, string | null> & { pages?: { type: string; slug: string; purpose: string }[]; constraints?: string[]; rawBrief?: string }; model: string; usedFallback: boolean }>(
      "/api/ai/extract-brief",
      {
        method: "POST",
        body: JSON.stringify({ conversationHistory }),
      }
    );
  },

  generate(prompt: string, task: string) {
    return apiFetch<{ text: string; model: string; usedFallback: boolean }>(
      "/api/ai/generate",
      {
        method: "POST",
        body: JSON.stringify({ prompt, task }),
      }
    );
  },

  extractThemeFields() {
    return apiFetch<{
      theme: Record<string, unknown>;
      result: { header?: { fieldCount: number }; footer?: { fieldCount: number } };
    }>("/api/ai/extract-theme-fields", { method: "POST" });
  },

  insights(page?: string) {
    const qs = page ? `?page=${encodeURIComponent(page)}` : "";
    return apiFetch<{ insights: Insight[] }>(`/api/ai/insights${qs}`);
  },

  chat(
    message: string,
    conversationHistory?: { role: "user" | "assistant"; content: string }[],
    currentPath?: string,
    onEvent?: (event: ChatStreamEvent) => void,
  ): Promise<ChatDonePayload> {
    return streamChat({ message, conversationHistory, currentPath }, onEvent);
  },

  decideTurn(turnId: string, decision: "accepted" | "rejected") {
    return apiFetch<{ ok: true; decision: string; undone?: number; accepted?: number }>(
      `/api/ai/turns/${turnId}/decision`,
      { method: "POST", body: JSON.stringify({ decision }) },
    );
  },

  generateImage(prompt: string, aspectRatio?: string) {
    return apiFetch<{ url: string; mediaId: string; filename?: string; altText?: string }>(
      "/api/ai/generate-image",
      {
        method: "POST",
        body: JSON.stringify({ prompt, aspectRatio }),
      }
    );
  },

  generateFavicon(prompt?: string) {
    return apiFetch<{ url: string; mediaId: string; filename: string }>(
      "/api/ai/generate-favicon",
      {
        method: "POST",
        body: JSON.stringify({ prompt }),
      }
    );
  },

  generateLogo(prompt?: string) {
    return apiFetch<{ url: string; mediaId: string; filename: string }>(
      "/api/ai/generate-logo",
      {
        method: "POST",
        body: JSON.stringify({ prompt }),
      }
    );
  },

  getPreferences() {
    return apiFetch<{ preferences: Record<string, string> }>("/api/ai/preferences");
  },

  updatePreferences(preferences: Record<string, string>) {
    return apiFetch<{ siteId: string; preferences: Record<string, string> }>(
      "/api/ai/preferences",
      {
        method: "PUT",
        body: JSON.stringify({ preferences }),
      }
    );
  },

  listHistory(params: {
    page?: number;
    limit?: number;
    taskType?: string;
    userDecision?: string;
    model?: string;
  } = {}) {
    const search = new URLSearchParams();
    if (params.page) search.set("page", String(params.page));
    if (params.limit) search.set("limit", String(params.limit));
    if (params.taskType) search.set("taskType", params.taskType);
    if (params.userDecision) search.set("userDecision", params.userDecision);
    if (params.model) search.set("model", params.model);
    const qs = search.toString();
    return apiFetch<{
      turns: Array<{
        turnId: string;
        taskType: string;
        action: string;
        reply: string | null;
        model: string | null;
        usedFallback: boolean;
        createdAt: string;
        decision: "accepted" | "rejected" | "partial" | null;
        hasPendingActions: boolean;
        actions: Array<{
          id: string;
          actionType: string | null;
          entityType: string | null;
          entityId: string | null;
          suggestion: string | null;
          userDecision: string | null;
          decidedAt: string | null;
        }>;
      }>;
      pagination: { page: number; limit: number; total: number; totalPages: number };
    }>(`/api/ai/history${qs ? `?${qs}` : ""}`);
  },

  decideHistory(id: string, decision: "accepted" | "rejected") {
    return apiFetch<{ ok: true; decision: string }>(
      `/api/ai/history/${id}/decision`,
      { method: "POST", body: JSON.stringify({ decision }) },
    );
  },

  analyze(contentId: string) {
    return apiFetch<{ analysis: string; model: string; usedFallback: boolean }>(
      "/api/ai/analyze",
      {
        method: "POST",
        body: JSON.stringify({ contentId }),
      }
    );
  },

  listStitchScreens(projectId: string) {
    return apiFetch<{
      screens: Array<{ screenId: string; name: string; screenshotUrl?: string }>;
    }>(`/api/ai/stitch-screens/${encodeURIComponent(projectId)}`);
  },

  async applyStitchScreen(projectId: string, screenId: string, contentId: string) {
    const { jobId } = await apiFetch<{ jobId: string }>(
      "/api/ai/apply-stitch-screen",
      {
        method: "POST",
        body: JSON.stringify({ projectId, screenId, contentId }),
      }
    );
    await waitForJob(jobId);
    return { success: true };
  },

  async applyStitchScreenAsTemplate(projectId: string, screenId: string) {
    const { jobId } = await apiFetch<{ jobId: string }>(
      "/api/ai/apply-stitch-screen",
      {
        method: "POST",
        body: JSON.stringify({ projectId, screenId, target: "post-template" }),
      }
    );
    await waitForJob(jobId);
    return { success: true };
  },

  async designPage(
    pageType: string,
    pagePurpose?: string,
    contentId?: string,
    target?: "post-template",
    opts?: { skipThemeWrite?: boolean; debug?: boolean },
  ) {
    const { jobId } = await apiFetch<{ jobId: string }>(
      "/api/ai/design-page",
      {
        method: "POST",
        body: JSON.stringify({
          pageType,
          pagePurpose,
          contentId,
          target,
          skipThemeWrite: opts?.skipThemeWrite,
          debug: opts?.debug,
        }),
      }
    );
    return waitForJob<{
      blocks: unknown[];
      model: string;
      imagePrompts?: Array<{ blockIndex: number; placeholderSrc: string; prompt: string; aspectRatio: string }>;
      debugHtmlUrl?: string;
    }>(jobId);
  },

  parseBrief(text: string) {
    return apiFetch<{ brief: Record<string, string | null> & { pages?: { type: string; slug: string; purpose: string }[]; constraints?: string[]; rawBrief?: string }; model: string; usedFallback: boolean }>(
      "/api/ai/parse-brief",
      { method: "POST", body: JSON.stringify({ text }) },
    );
  },

  enqueuePageImages(contentId: string, imagePrompts: Array<{ blockIndex: number; placeholderSrc: string; prompt: string; aspectRatio: string }>) {
    return apiFetch<{ ok: boolean }>(
      "/api/ai/enqueue-page-images",
      { method: "POST", body: JSON.stringify({ contentId, imagePrompts }) },
    );
  },
};

interface JobStatus<T = unknown> {
  id: string;
  type: string;
  status: "pending" | "processing" | "completed" | "failed";
  result: T | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

// Poll an enqueued AI job until it completes. Resolves with the job's result
// or throws with the recorded error message. Long polling interval — these
// jobs typically take 60-180s. Transient fetch errors (network blips, 429s)
// are tolerated up to maxConsecutivePollErrors before giving up so a single
// failed request doesn't kill a long-running job.
async function waitForJob<T = unknown>(
  jobId: string,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<T> {
  const intervalMs = opts.intervalMs ?? 3000;
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const maxConsecutivePollErrors = 5;
  const start = Date.now();
  let consecutiveErrors = 0;

  while (Date.now() - start < timeoutMs) {
    let job: JobStatus<T> | undefined;
    try {
      job = await apiFetch<JobStatus<T>>(`/api/ai/jobs/${jobId}`);
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors += 1;
      if (consecutiveErrors >= maxConsecutivePollErrors) {
        throw err;
      }
      console.warn(`Job ${jobId} poll error (${consecutiveErrors}/${maxConsecutivePollErrors}):`, err);
    }
    if (job?.status === "completed") {
      return (job.result ?? ({} as T));
    }
    if (job?.status === "failed") {
      throw new Error(job.error || "Job failed");
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Job ${jobId} timed out after ${timeoutMs}ms`);
}

// Billing
export interface BillingSubscription {
  id: string;
  status: string;
  trialStartedAt: string | null;
  trialEndsAt: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  billingUserId: string | null;
  stripePriceId: string | null;
  plan: "monthly" | "annual" | null;
}

export interface BillingPlanDetails {
  plan: "monthly" | "annual";
  priceId: string;
  amountUsd: number;
  interval: "month" | "year";
  label: string;
}

export interface BillingPaymentMethod {
  brand: string | null;
  last4: string | null;
  expiryMonth: number | null;
  expiryYear: number | null;
}

export interface BillingOwner {
  id: string;
  email: string;
  name: string;
}

export interface BillingPartner {
  id: string;
  code: string;
  name: string;
}

export interface BillingStatus {
  billing: "standard" | "free";
  // Set when a site is unlocked via a staff override with no Stripe sub —
  // either a comped plan or a staff-granted paid tier.
  comped?: boolean;
  plan?: "monthly" | "annual" | "comped";
  subscription: BillingSubscription | null;
  billingUser: BillingOwner | null;
  billingPartner: BillingPartner | null;
  paymentMethod: BillingPaymentMethod | null;
  hasPaymentMethod: boolean;
  addons?: { slug: string; name: string; priceCents: number; interval: string }[];
}

export const billing = {
  status() {
    return apiFetch<BillingStatus>("/api/billing");
  },

  plans() {
    return apiFetch<{ plans: BillingPlanDetails[] }>("/api/billing/plans");
  },

  changePlan(plan: "monthly" | "annual") {
    return apiFetch<{ ok: boolean; plan: string; priceId: string | null }>("/api/billing/change-plan", {
      method: "POST",
      body: JSON.stringify({ plan }),
    });
  },

  createCheckoutSession(opts: { returnUrl?: string; successUrl?: string; cancelUrl?: string; plan?: "monthly" | "annual" } | string = {}, plan?: "monthly" | "annual") {
    const body = typeof opts === "string" ? { returnUrl: opts, plan } : { ...opts, plan: opts.plan ?? plan };
    return apiFetch<{ url: string }>("/api/billing/checkout-session", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  createPortalSession(returnUrl?: string) {
    return apiFetch<{ url: string }>("/api/billing/portal-session", {
      method: "POST",
      body: JSON.stringify({ returnUrl }),
    });
  },

  cancel() {
    return apiFetch<{ ok: boolean }>("/api/billing/cancel", {
      method: "POST",
    });
  },

  reactivate() {
    return apiFetch<{ ok: boolean }>("/api/billing/reactivate", {
      method: "POST",
    });
  },

  transfer(opts: { targetUserId?: string; partnerCode?: string }) {
    return apiFetch<{ ok: boolean }>("/api/billing/transfer", {
      method: "PUT",
      body: JSON.stringify(opts),
    });
  },
};

// Form Submissions
export interface FormSubmissionAttachment {
  field: string;
  filename: string;
  path: string;
  size: number;
  contentType: string;
}

export interface FormSubmission {
  id: string;
  siteId: string;
  formIdentifier: string;
  data: Record<string, string>;
  attachments?: FormSubmissionAttachment[];
  submitterEmail: string | null;
  sourceUrl: string | null;
  ipAddress: string | null;
  webhookStatus: "pending" | "success" | "failed" | null;
  webhookAttempts: number;
  webhookError: string | null;
  webhookUpdatedAt: string | null;
  createdAt: string;
}

// Team
export interface TeamMember {
  id: string;
  userId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: string;
  status: string;
  invitedAt: string;
  joinedAt: string | null;
}

export const team = {
  list() {
    return apiFetch<{ members: TeamMember[] }>("/api/team");
  },

  invite(email: string, role: string) {
    return apiFetch<{ ok: boolean; memberId: string }>("/api/team/invite", {
      method: "POST",
      body: JSON.stringify({ email, role }),
    });
  },

  changeRole(memberId: string, role: string) {
    return apiFetch<{ ok: boolean }>(`/api/team/${memberId}/role`, {
      method: "PUT",
      body: JSON.stringify({ role }),
    });
  },

  remove(memberId: string) {
    return apiFetch<{ ok: boolean }>(`/api/team/${memberId}`, {
      method: "DELETE",
    });
  },
};

// Audit Log
export interface AuditEntry {
  id: string;
  actorType: string;
  actorId: string | null;
  actorName: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export const auditLog = {
  list(siteId: string, opts?: { page?: number; limit?: number; actorType?: string; action?: string; entityType?: string }) {
    const params = new URLSearchParams();
    if (opts?.page) params.set("page", String(opts.page));
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.actorType) params.set("actorType", opts.actorType);
    if (opts?.action) params.set("action", opts.action);
    if (opts?.entityType) params.set("entityType", opts.entityType);
    const qs = params.toString();
    return apiFetch<{
      entries: AuditEntry[];
      pagination: { page: number; limit: number; total: number; totalPages: number };
    }>(`/api/sites/${siteId}/audit-log${qs ? `?${qs}` : ""}`);
  },
};

export interface SubmissionFilters {
  form?: string;
  from?: string;
  to?: string;
  search?: string;
}

function buildSubmissionQuery(filters: SubmissionFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.form) params.set("form", filters.form);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.search) params.set("search", filters.search);
  return params;
}

export const submissions = {
  list(filters: SubmissionFilters = {}, limit = 50, offset = 0) {
    const params = buildSubmissionQuery(filters);
    params.set("limit", String(limit));
    params.set("offset", String(offset));
    return apiFetch<{ items: FormSubmission[]; total: number }>(
      `/api/form-submissions?${params}`
    );
  },

  forms() {
    return apiFetch<{ forms: { formIdentifier: string; count: number; name: string | null }[] }>(
      "/api/form-submissions/forms"
    );
  },

  get(id: string) {
    return apiFetch<FormSubmission>(`/api/form-submissions/${id}`);
  },

  delete(id: string) {
    return apiFetch<{ success: boolean }>(`/api/form-submissions/${id}`, {
      method: "DELETE",
    });
  },

  resendWebhook(id: string) {
    return apiFetch<{ submission: FormSubmission }>(`/api/form-submissions/${id}/resend-webhook`, {
      method: "POST",
    });
  },

  // Fetch an attachment (auth header required, so no plain <a href>) and hand
  // it to the browser as a download.
  async downloadAttachment(id: string, index: number, filename: string) {
    const headers: Record<string, string> = {};
    const token = getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    if (currentSiteId) headers["x-site-id"] = currentSiteId;
    const res = await fetch(`${API_BASE}/api/form-submissions/${id}/attachments/${index}/download`, { headers });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error((errBody as { error?: string }).error || `Download failed: ${res.status}`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },

  webhookSecret() {
    return apiFetch<{ secret: string | null }>("/api/form-submissions/webhook-secret");
  },

  rotateWebhookSecret() {
    return apiFetch<{ secret: string | null }>("/api/form-submissions/webhook-secret/rotate", {
      method: "POST",
    });
  },

  async exportCsv(filters: SubmissionFilters = {}) {
    const params = buildSubmissionQuery(filters);
    const qs = params.toString();
    const res = await apiRawFetch(`/api/form-submissions/export.csv${qs ? `?${qs}` : ""}`);
    if (!res.ok) throw new Error(`Export failed: ${res.status}`);
    const blob = await res.blob();
    const disposition = res.headers.get("Content-Disposition") || "";
    const match = disposition.match(/filename="?([^"]+)"?/);
    const filename = match?.[1] || `form-submissions-${new Date().toISOString().slice(0, 10)}.csv`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },
};

export interface SupportTicket {
  id: string;
  siteId: string;
  userId: string;
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
  submit(data: { type: string; subject: string; body: string; priority?: string }) {
    return apiFetch<{ ticket: SupportTicket }>("/api/support/tickets", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  mine() {
    return apiFetch<{ tickets: SupportTicket[] }>("/api/support/tickets/mine");
  },

  comments(ticketId: string) {
    return apiFetch<{ comments: TicketComment[] }>(`/api/support/tickets/${ticketId}/comments`);
  },
};

// WordPress Import
export interface WpAuthor {
  login: string;
  displayName: string;
}

export interface WpCategory {
  name: string;
  slug: string;
  postCount: number;
}

export interface WpTag {
  name: string;
  slug: string;
}

export interface WpAnalyzeResult {
  jobId: string;
  postCount: number;
  pageCount: number;
  attachmentCount: number;
  authors: WpAuthor[];
  categories: WpCategory[];
  tags: WpTag[];
  hasMedia: boolean;
}

export interface WpImportOptions {
  importDrafts: boolean;
  importMedia: boolean;
  authorMap: Record<string, string>;
  categoryMap: Record<string, "new" | string>;
  includePostTypes: ("post" | "page")[];
}

export interface WpImportResult {
  imported: { posts: number; pages: number; media: number };
  skipped: number;
  renamedSlugs: Array<{ originalSlug: string; newSlug: string; title: string }>;
  mediaErrors: Array<{ url: string; reason: string }>;
  otherErrors: string[];
}

export interface WpJobStatus {
  id: string;
  status: "pending" | "analyzing" | "running" | "completed" | "failed";
  progress: number;
  total: number;
  result: WpImportResult | null;
  createdAt: string;
  updatedAt: string;
}

// HTML Import
export interface HtmlImportResult {
  pageId: string;
  pageSlug: string;
  blocksImported: number;
  imagesImported: number;
  imagesSkipped: number;
  themeCreated?: boolean;
}

export const importHTML = {
  async importFile(
    siteId: string,
    file: File,
    pageTitle?: string,
    themeSetup?: "extract" | "brief",
    themeBrief?: string,
  ): Promise<HtmlImportResult> {
    const formData = new FormData();
    formData.append("file", file);
    if (pageTitle) formData.append("pageTitle", pageTitle);
    if (themeSetup) formData.append("themeSetup", themeSetup);
    if (themeBrief) formData.append("themeBrief", themeBrief);

    const headers: Record<string, string> = {};
    const token = getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    headers["x-site-id"] = siteId;

    const res = await fetch(`${API_BASE}/api/import/html`, {
      method: "POST",
      headers,
      body: formData,
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error((body as { error?: string }).error || `Import failed: ${res.status}`);
    }

    // The import runs as a background job (it exceeds the CDN edge timeout for
    // content-heavy pages). Poll until it finishes and return the result.
    const { jobId } = (await res.json()) as { jobId: string };
    return waitForJob<HtmlImportResult>(jobId, { timeoutMs: 12 * 60 * 1000 });
  },
};

export const importWP = {
  async analyze(siteId: string, file: File): Promise<WpAnalyzeResult> {
    const formData = new FormData();
    formData.append("file", file);

    const headers: Record<string, string> = {};
    const token = getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    headers["x-site-id"] = siteId;

    const res = await fetch(`${API_BASE}/api/import/wordpress/analyze`, {
      method: "POST",
      headers,
      body: formData,
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error((body as { error?: string }).error || `Analyze failed: ${res.status}`);
    }

    return res.json();
  },

  start(siteId: string, jobId: string, options: WpImportOptions) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const token = getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    headers["x-site-id"] = siteId;

    return apiFetch<{ jobId: string }>("/api/import/wordpress/start", {
      method: "POST",
      headers,
      body: JSON.stringify({ jobId, options }),
    });
  },

  jobStatus(siteId: string, jobId: string) {
    const headers: Record<string, string> = {};
    const token = getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    headers["x-site-id"] = siteId;

    return apiFetch<WpJobStatus>(`/api/import/jobs/${jobId}`);
  },
};

export const platformAdmin = {
  themeDebug(siteId: string) {
    return apiFetch<Record<string, unknown>>(`/api/admin/sites/${siteId}/theme-debug`);
  },
  recompileTheme(siteId: string) {
    return apiFetch<{ ok: boolean; beforeBytes: number; afterBytes: number; blockCount: number }>(
      `/api/admin/sites/${siteId}/recompile-theme`,
      { method: "POST" },
    );
  },
};

// ── Partner portal ────────────────────────────────────────────────────────────

export interface PartnerOverview {
  partner: {
    name: string;
    code: string;
    isAgency: boolean;
    commissionRate: string | null;
    commissionsOnAddons: boolean;
    status: string;
  };
  referrals: {
    id: string;
    siteName: string;
    status: string;
    createdAt: string;
    qualifiedAt: string | null;
    rewardedAt: string | null;
  }[];
  linkedSites: {
    siteId: string;
    siteName: string;
    subdomain: string;
    siteStatus: string;
    billingActive: boolean;
    linkedAt: string;
  }[];
}

export const partner = {
  overview() {
    return apiFetch<PartnerOverview>("/api/partner/overview");
  },
};
