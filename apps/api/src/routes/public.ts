import { Hono } from "hono";
import { eq, and, desc, sql } from "drizzle-orm";
import { db, sites, content, contentBlocks, navigation, formSubmissions, users, redirects } from "@cadmus/db";
import type { SiteEnv } from "../middleware/tenant.js";
import { verifyPreviewToken } from "../lib/preview.js";
import { getEmailProvider } from "../lib/email.js";
import { createRateLimiter, getClientIp } from "../lib/rate-limit.js";
import { sanitizeHtmlBlock } from "../lib/sanitize-html-block.js";
import { deliverFormWebhook, ensureSiteWebhookSecret } from "../lib/form-webhook.js";
import { buildLlmsTxt, canonicalOrigin, type LlmsContentItem } from "../lib/llms-txt.js";
import { getPublicAddonsPayload, getActiveSiteAddons } from "../lib/addons.js";
import { verifyTurnstileToken } from "../lib/turnstile.js";
import { getSiteHost } from "../lib/urls.js";
import {
  storeFormUploads,
  getFormUploadsStorage,
  MAX_FILES_PER_SUBMISSION,
  MAX_FILE_BYTES,
  type FormAttachment,
} from "../lib/form-uploads.js";
import { logError } from "../lib/log.js";
import { getAIRouter } from "./ai.js";
import type { SiteBrief } from "@cadmus/shared";

export const publicRoutes = new Hono<SiteEnv>();

// Published slug + schemaData for a content type, for llms.txt generation.
async function listPublishedForLlms(
  siteId: string,
  type: string,
  limit: number,
): Promise<LlmsContentItem[]> {
  return db
    .select({ slug: content.slug, schemaData: content.schemaData })
    .from(content)
    .where(and(eq(content.siteId, siteId), eq(content.status, "published"), eq(content.type, type)))
    .orderBy(desc(content.publishedAt))
    .limit(limit);
}

// Defensive render-time gate: html blocks and theme header/footer are stored raw
// and rendered into visitor pages via set:html. Write paths sanitize on save, but
// sanitizing again here guarantees content created BEFORE that (or by any missed
// path) can't deliver script to visitors. Idempotent on already-clean HTML.
type ServedBlock = { blockType?: string | null; data?: unknown };
// Form config that must never reach the public browser: the notification email
// and the webhook target. (The webhook signing secret lives in site settings,
// stripped separately below.)
const SERVER_ONLY_FORM_KEYS = ["notificationEmail", "webhookUrl", "webhookEnabled"];
function stripServerOnlyFormFields(obj: Record<string, unknown> | undefined): void {
  if (!obj || typeof obj !== "object") return;
  for (const key of SERVER_ONLY_FORM_KEYS) delete obj[key];
}
function sanitizeServedBlocks<T extends ServedBlock>(blocks: T[]): T[] {
  for (const block of blocks) {
    const data = block?.data as Record<string, unknown> | undefined;
    if (block?.blockType === "html") {
      if (data && typeof data.html === "string") data.html = sanitizeHtmlBlock(data.html);
      stripServerOnlyFormFields(data?.formSettings as Record<string, unknown> | undefined);
    } else if (block?.blockType === "form") {
      stripServerOnlyFormFields(data); // FormBlock stores settings at top level
    }
  }
  return blocks;
}
function sanitizeServedTheme(settings: unknown): void {
  const theme = (settings as { theme?: Record<string, unknown> } | null)?.theme;
  if (!theme) return;
  if (typeof theme.headerHtml === "string") theme.headerHtml = sanitizeHtmlBlock(theme.headerHtml);
  if (typeof theme.footerHtml === "string") theme.footerHtml = sanitizeHtmlBlock(theme.footerHtml);
}

// Public site info (name, subdomain, domain, settings — omits brief/internal data)
publicRoutes.get("/site", async (c) => {
  const siteCtx = c.get("site");
  if (!siteCtx?.siteId) {
    return c.json({ error: "Site context is required" }, 400);
  }

  const [site] = await db
    .select({
      id: sites.id,
      name: sites.name,
      subdomain: sites.subdomain,
      domain: sites.domain,
      domainStatus: sites.domainStatus,
      plan: sites.plan,
      settings: sites.settings,
      brief: sites.brief,
    })
    .from(sites)
    .where(eq(sites.id, siteCtx.siteId));

  if (!site) {
    return c.json({ error: "Site not found" }, 404);
  }

  sanitizeServedTheme(site.settings);
  // Strip server-only settings from the public payload: formDefaults holds form
  // config (notification email, webhook URL, signing secret); designIntent is
  // internal AI-editing guidance. Neither is needed by visitors.
  if (site.settings && typeof site.settings === "object") {
    delete (site.settings as Record<string, unknown>).formDefaults;
    delete (site.settings as Record<string, unknown>).designIntent;
  }
  // Active add-ons, projected to their PUBLIC config subset (no secrets). The
  // domain context lets host-scoped keys (Turnstile) drop out on custom domains
  // the platform widget can't serve.
  const addons = await getPublicAddonsPayload(siteCtx.siteId, {
    hasActiveCustomDomain: !!site.domain && site.domainStatus === "active",
  });
  return c.json({ ...site, addons });
});

// List published content (no blocks — list view only)
publicRoutes.get("/content", async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) {
    return c.json({ error: "Site context is required" }, 400);
  }

  const type = c.req.query("type");
  const limit = Math.min(Number(c.req.query("limit")) || 50, 100);
  const offset = Number(c.req.query("offset")) || 0;

  const conditions = [
    eq(content.siteId, siteId),
    eq(content.status, "published"),
  ];
  if (type) conditions.push(eq(content.type, type));

  const [items, countResult] = await Promise.all([
    db
      .select()
      .from(content)
      .where(and(...conditions))
      .orderBy(desc(content.publishedAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)` })
      .from(content)
      .where(and(...conditions)),
  ]);

  return c.json({ items, total: Number(countResult[0].count) });
});

// Search published content — title/excerpt/slug, plus block text
publicRoutes.get("/search", async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) {
    return c.json({ error: "Site context is required" }, 400);
  }

  const q = (c.req.query("q") ?? "").trim();
  if (!q) {
    return c.json({ items: [], total: 0, query: "" });
  }
  if (q.length > 200) {
    return c.json({ error: "Query too long" }, 400);
  }

  const limit = Math.min(Number(c.req.query("limit")) || 20, 50);
  const offset = Number(c.req.query("offset")) || 0;
  const pattern = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

  const matchExpr = sql`(
    ${content.slug} ILIKE ${pattern}
    OR (${content.schemaData}->>'title') ILIKE ${pattern}
    OR (${content.schemaData}->>'metaDescription') ILIKE ${pattern}
    OR (${content.schemaData}->>'excerpt') ILIKE ${pattern}
    OR EXISTS (
      SELECT 1 FROM ${contentBlocks}
      WHERE ${contentBlocks.contentId} = ${content.id}
        AND ${contentBlocks.data}::text ILIKE ${pattern}
    )
  )`;

  const conditions = [
    eq(content.siteId, siteId),
    eq(content.status, "published"),
    matchExpr,
  ];

  const [items, countResult] = await Promise.all([
    db
      .select({
        id: content.id,
        siteId: content.siteId,
        type: content.type,
        slug: content.slug,
        status: content.status,
        schemaData: content.schemaData,
        publishedAt: content.publishedAt,
        createdAt: content.createdAt,
        updatedAt: content.updatedAt,
      })
      .from(content)
      .where(and(...conditions))
      .orderBy(desc(content.publishedAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)` })
      .from(content)
      .where(and(...conditions)),
  ]);

  return c.json({ items, total: Number(countResult[0].count), query: q });
});

// Slug lookup — the key public endpoint
publicRoutes.get("/content/:slug", async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) {
    return c.json({ error: "Site context is required" }, 400);
  }

  const slug = c.req.param("slug");

  const [item] = await db
    .select()
    .from(content)
    .where(
      and(
        eq(content.siteId, siteId),
        eq(content.slug, slug),
        eq(content.status, "published")
      )
    );

  if (!item) {
    return c.json({ error: "Content not found" }, 404);
  }

  const blocks = await db
    .select()
    .from(contentBlocks)
    .where(eq(contentBlocks.contentId, item.id))
    .orderBy(contentBlocks.position);

  // Resolve author name for posts
  let authorName: string | undefined;
  if (item.createdBy) {
    const [author] = await db
      .select({ firstName: users.firstName, lastName: users.lastName })
      .from(users)
      .where(eq(users.id, item.createdBy));
    if (author) {
      const parts = [author.firstName, author.lastName].filter(Boolean);
      if (parts.length > 0) authorName = parts.join(" ");
    }
  }

  return c.json({ ...item, blocks: sanitizeServedBlocks(blocks), authorName });
});

// Preview — verify token and return content regardless of status
publicRoutes.get("/preview/:token", async (c) => {
  const token = c.req.param("token");

  const payload = await verifyPreviewToken(token);
  if (!payload) {
    return c.json({ error: "Invalid or expired preview token" }, 401);
  }

  const siteId = c.get("site")?.siteId;
  if (siteId && siteId !== payload.siteId) {
    return c.json({ error: "Preview token does not match site" }, 403);
  }

  const [item] = await db
    .select()
    .from(content)
    .where(
      and(
        eq(content.id, payload.contentId),
        eq(content.siteId, payload.siteId)
      )
    );

  if (!item) {
    return c.json({ error: "Content not found" }, 404);
  }

  const blocks = await db
    .select()
    .from(contentBlocks)
    .where(eq(contentBlocks.contentId, item.id))
    .orderBy(contentBlocks.position);

  let authorName: string | undefined;
  if (item.createdBy) {
    const [author] = await db
      .select({ firstName: users.firstName, lastName: users.lastName })
      .from(users)
      .where(eq(users.id, item.createdBy));
    if (author) {
      const parts = [author.firstName, author.lastName].filter(Boolean);
      if (parts.length > 0) authorName = parts.join(" ");
    }
  }

  return c.json({ ...item, blocks: sanitizeServedBlocks(blocks), authorName, _preview: true });
});

// Navigation items
publicRoutes.get("/navigation", async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) {
    return c.json({ error: "Site context is required" }, 400);
  }

  const location = c.req.query("location");
  const conditions = [eq(navigation.siteId, siteId)];
  if (location) conditions.push(eq(navigation.location, location));

  const items = await db
    .select()
    .from(navigation)
    .where(and(...conditions));

  return c.json({ items });
});

// ── Form Submissions ──────────────────────────────────────────────────────

const formLimiter = createRateLimiter("public.formSubmit", 5, 60_000);

// Minimum time between page load and submit for a real human. Bots typically
// post in well under a second; humans take at least this long to fill and
// submit even a single-field newsletter form.
const MIN_SUBMIT_MS = 1500;

publicRoutes.post("/forms/submit", async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) {
    return c.json({ error: "Site context is required" }, 400);
  }

  const ip = getClientIp({
    "x-forwarded-for": c.req.header("x-forwarded-for") ?? null,
    "x-real-ip": c.req.header("x-real-ip") ?? null,
  });
  if (!formLimiter.check(`${siteId}:${ip}`)) {
    return c.json({ error: "Too many submissions. Please try again later." }, 429);
  }

  // Two body shapes: plain JSON (the default), or multipart/form-data when the
  // form carries file attachments (form-file-uploads add-on) — a `payload` part
  // holding the same JSON, plus `file:<fieldName>` parts for each file.
  interface SubmitBody {
    formIdentifier: string;
    fields: Record<string, string>;
    sourceUrl?: string;
    honeypot?: string;
    renderedAt?: number;
    turnstileToken?: string;
  }
  let body: SubmitBody;
  const uploads: Array<{ field: string; file: File }> = [];
  if ((c.req.header("content-type") || "").includes("multipart/form-data")) {
    // Multipart parsing buffers in memory — cap the request before touching it.
    const declaredBytes = Number(c.req.header("content-length"));
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_FILES_PER_SUBMISSION * MAX_FILE_BYTES + 1024 * 1024) {
      return c.json({ error: "Submission too large" }, 413);
    }
    const parsed = await c.req.parseBody({ all: true });
    const payloadRaw = parsed["payload"];
    if (typeof payloadRaw !== "string") {
      return c.json({ error: "Missing payload" }, 400);
    }
    try {
      body = JSON.parse(payloadRaw) as SubmitBody;
    } catch {
      return c.json({ error: "Invalid payload" }, 400);
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (!key.startsWith("file:")) continue;
      const field = key.slice(5);
      for (const v of Array.isArray(value) ? value : [value]) {
        if (v instanceof File && v.size > 0) uploads.push({ field, file: v });
      }
    }
  } else {
    body = await c.req.json<SubmitBody>();
  }

  // Honeypot: a real user can't see the field, so any value means a bot.
  // Silent success so the bot doesn't learn to avoid it.
  if (typeof body.honeypot === "string" && body.honeypot.trim().length > 0) {
    return c.json({ success: true });
  }

  // Timing check: reject near-instant submits. Ignored if the client didn't
  // send a timestamp (older cached page, JS disabled).
  if (
    typeof body.renderedAt === "number" &&
    Number.isFinite(body.renderedAt) &&
    Date.now() - body.renderedAt < MIN_SUBMIT_MS
  ) {
    return c.json({ success: true });
  }

  // Turnstile spam protection — gated behind the add-on entitlement. Non-entitled
  // sites see zero behavior change. One query resolves both entitlement and the
  // site's per-add-on config (BYO or auto-provisioned keys).
  const activeAddons = await getActiveSiteAddons(siteId);
  const turnstileAddon = activeAddons.find((a) => a.slug === "turnstile-spam-protection");
  if (turnstileAddon) {
    const cfgStr = (v: unknown): string | undefined =>
      typeof v === "string" && v.trim() ? v.trim() : undefined;
    const [siteRow] = await db
      .select({ subdomain: sites.subdomain, domain: sites.domain, domainStatus: sites.domainStatus })
      .from(sites)
      .where(eq(sites.id, siteId));
    const onCustomDomain = !!siteRow?.domain && siteRow.domainStatus === "active";

    // Secret precedence mirrors the sitekey projection: user BYO → auto-
    // provisioned pool secret → platform secret. The platform widget only
    // covers *.cadmus.digital, so on an active custom domain with no per-site
    // secret the client never rendered a widget — don't demand a token.
    // .trim(): defensive against a trailing newline in the GCP secret, which
    // would make every siteverify call fail (same gotcha as the CF token).
    const secret =
      cfgStr(turnstileAddon.config.secretKey) ||
      cfgStr(turnstileAddon.config.provisionedSecretKey) ||
      (onCustomDomain ? undefined : process.env.TURNSTILE_SECRET_KEY?.trim());

    if (!secret) {
      // Fail-open: no usable secret for this site's serving context (platform
      // misconfig, or a custom domain awaiting provisioning) must not break
      // visitor forms. Warn so ops can catch it.
      console.warn(
        `[turnstile] site ${siteId} has turnstile-spam-protection active but no usable secret for its serving context; skipping verification`,
      );
    } else {
      const token = typeof body.turnstileToken === "string" ? body.turnstileToken.trim() : "";
      const spamError = "Spam verification failed. Please refresh the page and try again.";
      if (!token) {
        return c.json({ error: spamError }, 400);
      }
      const result = await verifyTurnstileToken(token, secret, ip);
      if (!result.success) {
        return c.json({ error: spamError }, 400);
      }
      // Bind the token to THIS site's hosts. Platform and pool widgets are
      // shared across tenants (one secret serves many sites), so without this
      // a token solved on tenant A's domain would verify for tenant B's form.
      if (result.hostname && siteRow) {
        const verified = result.hostname.toLowerCase();
        const allowed = new Set<string>();
        allowed.add(getSiteHost(siteRow.subdomain).toLowerCase());
        if (siteRow.domain) {
          const d = siteRow.domain.toLowerCase();
          const apex = d.replace(/^www\./, "");
          allowed.add(d);
          allowed.add(apex);
          allowed.add(`www.${apex}`);
        }
        if (!allowed.has(verified)) {
          console.warn(`[turnstile] site ${siteId}: token hostname ${verified} not in allowed set`);
          return c.json({ error: spamError }, 400);
        }
      }
    }
  }

  // Validate
  if (!body.formIdentifier || typeof body.formIdentifier !== "string") {
    return c.json({ error: "formIdentifier is required" }, 400);
  }
  if (!body.fields || typeof body.fields !== "object" || Object.keys(body.fields).length === 0) {
    return c.json({ error: "fields must be a non-empty object" }, 400);
  }
  // Ensure all values are strings
  for (const [key, val] of Object.entries(body.fields)) {
    if (typeof val !== "string") {
      return c.json({ error: `Field "${key}" must be a string` }, 400);
    }
  }

  // Look up form config server-side (never trust client-sent emails)
  let notificationEmail: string | undefined;
  let confirmationEnabled = false;
  let confirmationMessage: string | undefined;
  let webhookUrl: string | undefined;
  let webhookEnabled = false;
  let formName: string | undefined;

  if (body.formIdentifier.startsWith("form:") || body.formIdentifier.startsWith("block:")) {
    const isFormId = body.formIdentifier.startsWith("form:");
    const id = body.formIdentifier.slice(isFormId ? 5 : 6);

    // form: identifiers need a JSON lookup; block: identifiers can hit the PK
    // directly. Both join through content and filter by the hostname-resolved
    // siteId so a form id from another tenant can't resolve this site's config.
    const [block] = isFormId
      ? await db
          .select({ data: contentBlocks.data })
          .from(contentBlocks)
          .innerJoin(content, eq(contentBlocks.contentId, content.id))
          .where(
            and(
              eq(content.siteId, siteId),
              sql`${contentBlocks.data}->>'formId' = ${id} OR ${contentBlocks.data}->'formSettings'->>'formId' = ${id}`,
            ),
          )
          .limit(1)
      : await db
          .select({ data: contentBlocks.data })
          .from(contentBlocks)
          .innerJoin(content, eq(contentBlocks.contentId, content.id))
          .where(and(eq(contentBlocks.id, id), eq(content.siteId, siteId)));

    if (block?.data && typeof block.data === "object") {
      const d = block.data as Record<string, unknown>;
      // FormBlock stores settings at top level; HtmlBlock stores them in formSettings
      const fs = (d.formSettings as Record<string, unknown> | undefined) ?? d;
      notificationEmail = typeof fs.notificationEmail === "string" ? fs.notificationEmail : undefined;
      confirmationEnabled = fs.confirmationEnabled === true;
      confirmationMessage = typeof fs.confirmationMessage === "string" ? fs.confirmationMessage : undefined;
      formName = typeof fs.name === "string" ? fs.name : undefined;
      if (typeof fs.webhookUrl === "string") webhookUrl = fs.webhookUrl;
      webhookEnabled = fs.webhookEnabled === true;

      // Enforce required checkbox (consent) fields server-side for structured
      // FormBlock forms — client-side `required` alone is bypassable, and a
      // checkbox is typically a legal acknowledgment.
      const fieldDefs = Array.isArray(d.fields) ? (d.fields as Array<Record<string, unknown>>) : [];
      for (const f of fieldDefs) {
        if (f.type !== "checkbox" || f.required !== true || typeof f.name !== "string") continue;
        const v = body.fields[f.name];
        const checked = typeof v === "string" && ["yes", "true", "on", "1"].includes(v.trim().toLowerCase());
        if (!checked) {
          const label = typeof f.label === "string" && f.label.trim() ? f.label : "the required box";
          return c.json({ error: `Please confirm: ${label}` }, 400);
        }
      }
    }
  } else {
    // Stitch/HTML forms — use site-level defaults
    const [site] = await db
      .select({ settings: sites.settings })
      .from(sites)
      .where(eq(sites.id, siteId));
    if (site?.settings && typeof site.settings === "object") {
      const defaults = (site.settings as Record<string, unknown>).formDefaults as Record<string, unknown> | undefined;
      if (defaults) {
        notificationEmail = typeof defaults.notificationEmail === "string" ? defaults.notificationEmail : undefined;
        confirmationEnabled = defaults.confirmationEnabled === true;
        confirmationMessage = typeof defaults.confirmationMessage === "string" ? defaults.confirmationMessage : undefined;
      }
    }
  }

  // Fall back to site-level defaults if block-level config had no notification email
  if (!notificationEmail) {
    const [siteRow] = await db
      .select({ settings: sites.settings })
      .from(sites)
      .where(eq(sites.id, siteId));
    if (siteRow?.settings && typeof siteRow.settings === "object") {
      const defaults = (siteRow.settings as Record<string, unknown>).formDefaults as Record<string, unknown> | undefined;
      if (defaults) {
        if (!notificationEmail && typeof defaults.notificationEmail === "string") {
          notificationEmail = defaults.notificationEmail;
        }
        if (!confirmationEnabled && defaults.confirmationEnabled === true) {
          confirmationEnabled = true;
          confirmationMessage = confirmationMessage || (typeof defaults.confirmationMessage === "string" ? defaults.confirmationMessage : undefined);
        }
      }
    }
  }

  // Site-level webhook default, if the form block didn't set one
  if (!webhookUrl) {
    const [siteRow] = await db.select({ settings: sites.settings }).from(sites).where(eq(sites.id, siteId));
    const defaults = (siteRow?.settings as Record<string, unknown> | undefined)?.formDefaults as Record<string, unknown> | undefined;
    if (defaults && typeof defaults.webhookUrl === "string") {
      webhookUrl = defaults.webhookUrl;
      webhookEnabled = defaults.webhookEnabled === true;
    }
  }
  const webhookActive = webhookEnabled && !!webhookUrl;

  // Extract submitter email from fields
  const submitterEmail = body.fields.email
    || Object.values(body.fields).find((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))
    || null;

  // File attachments — gated on the add-on entitlement. Validation and upload
  // happen before the insert so a rejected file rejects the whole submission
  // (no half-recorded entries pointing at missing objects).
  let attachments: FormAttachment[] = [];
  if (uploads.length > 0) {
    const entitled = activeAddons.some((a) => a.slug === "form-file-uploads");
    if (!entitled) {
      return c.json({ error: "File uploads are not enabled for this site." }, 400);
    }
    if (!getFormUploadsStorage()) {
      logError(`[form-uploads] site ${siteId} submitted files but FORM_UPLOADS_BUCKET is not configured`, new Error("bucket unconfigured"));
      return c.json({ error: "File uploads are temporarily unavailable. Please try again later." }, 503);
    }
    const stored = await storeFormUploads(siteId, uploads);
    if (!stored.ok) {
      return c.json({ error: stored.error }, 400);
    }
    attachments = stored.attachments;
  }

  // Insert submission (pending webhook status when a webhook is configured)
  const [submission] = await db.insert(formSubmissions).values({
    siteId,
    formIdentifier: body.formIdentifier,
    data: body.fields,
    attachments,
    submitterEmail,
    sourceUrl: body.sourceUrl || null,
    ipAddress: ip,
    webhookStatus: webhookActive ? "pending" : null,
  }).returning({ id: formSubmissions.id });

  // Fire-and-forget: notification email
  const email = getEmailProvider();
  if (email && notificationEmail) {
    const rows = Object.entries(body.fields)
      .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;font-weight:600">${escapeHtml(prettifyFieldKey(k))}</td><td style="padding:4px 0">${escapeHtml(v)}</td></tr>`)
      .join("");
    // Attachment names only — the files live in a private bucket and are
    // downloadable from the Forms page in the site admin.
    const attachmentsHtml = attachments.length
      ? `<p style="margin-top:12px"><strong>Attachments (${attachments.length}):</strong> ${attachments
          .map((a) => `${escapeHtml(a.filename)} (${Math.max(1, Math.round(a.size / 1024))} KB)`)
          .join(", ")}<br/><span style="color:#888;font-size:12px">Download from the Forms page in your site admin.</span></p>`
      : "";
    email
      .send({
        to: notificationEmail,
        from: "Cadmus <noreply@cadmus.digital>",
        subject: "New form submission",
        replyTo: submitterEmail || undefined,
        html: `<h2>New form submission</h2><table>${rows}</table>${attachmentsHtml}<p style="color:#888;font-size:12px">Source: ${escapeHtml(body.sourceUrl || "unknown")}</p>`,
      })
      .catch((err) => console.error("Notification email failed:", err));
  }

  // Fire-and-forget: confirmation email
  if (email && confirmationEnabled && submitterEmail) {
    email
      .send({
        to: submitterEmail,
        from: "Cadmus <noreply@cadmus.digital>",
        subject: "We received your message",
        html: confirmationMessage
          ? `<p>${escapeHtml(confirmationMessage)}</p>`
          : "<p>Thank you for reaching out. We've received your submission and will get back to you soon.</p>",
      })
      .catch((err) => console.error("Confirmation email failed:", err));
  }

  // Fire-and-forget: webhook delivery (signed, retried, SSRF-guarded). The API
  // runs with no-cpu-throttling so this completes after the response returns.
  if (webhookActive && submission) {
    void (async () => {
      const secret = await ensureSiteWebhookSecret(siteId);
      if (!secret) return;
      await deliverFormWebhook({
        submissionId: submission.id,
        url: webhookUrl!,
        secret,
        payload: {
          event: "form.submission",
          siteId,
          submissionId: submission.id,
          formIdentifier: body.formIdentifier,
          formName,
          fields: body.fields,
          // Metadata only — no storage paths or URLs; files are retrieved
          // through the authenticated admin API.
          attachments: attachments.map((a) => ({ filename: a.filename, size: a.size, contentType: a.contentType })),
          submitterEmail,
          sourceUrl: body.sourceUrl || null,
          submittedAt: new Date().toISOString(),
        },
      });
    })().catch((err) => console.error("Webhook delivery failed:", err));
  }

  return c.json({ success: true });
});

// ── Visitor Chatbot ────────────────────────────────────────────────────────
// Gated behind the "visitor-chatbot" add-on entitlement. Answers visitor
// questions strictly from the site's own context (brief + published content +
// owner-supplied instructions). No history is persisted and message contents
// are never logged.

const visitorChatLimiter = createRateLimiter("public.visitorChat", 10, 60_000);

interface ChatHistoryEntry {
  role: "user" | "assistant";
  content: string;
}

function clampText(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

publicRoutes.post("/chat", async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) {
    return c.json({ error: "Site context is required" }, 400);
  }

  // Entitlement gate: the add-on must be active AND not explicitly disabled.
  const activeAddons = await getActiveSiteAddons(siteId);
  const chatAddon = activeAddons.find((a) => a.slug === "visitor-chatbot");
  if (!chatAddon || chatAddon.config.enabled === false) {
    return c.json({ error: "Chat is not available" }, 404);
  }

  const ip = getClientIp({
    "x-forwarded-for": c.req.header("x-forwarded-for") ?? null,
    "x-real-ip": c.req.header("x-real-ip") ?? null,
  });
  if (!visitorChatLimiter.check(`${siteId}:${ip}`)) {
    return c.json({ error: "Too many messages. Please slow down and try again shortly." }, 429);
  }

  const body = await c.req
    .json<{ message?: unknown; history?: unknown }>()
    .catch(() => ({}) as { message?: unknown; history?: unknown });

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    return c.json({ error: "message is required" }, 400);
  }
  if (message.length > 1000) {
    return c.json({ error: "Message is too long (max 1000 characters)." }, 400);
  }

  // Keep only the most recent turns, and clamp each message so a hostile client
  // can't blow up the prompt.
  const history: ChatHistoryEntry[] = Array.isArray(body.history)
    ? (body.history as unknown[])
        .filter(
          (h): h is { role: unknown; content: unknown } =>
            !!h && typeof h === "object",
        )
        .map((h): ChatHistoryEntry => ({
          role: (h as { role?: unknown }).role === "assistant" ? "assistant" : "user",
          content: clampText((h as { content?: unknown }).content, 1000),
        }))
        .filter((h) => h.content.length > 0)
        .slice(-10)
    : [];

  const router = getAIRouter();
  if (!router) {
    return c.json({ error: "The assistant is unavailable right now." }, 503);
  }

  // ── Assemble the business context ──────────────────────────────────────────
  const [site] = await db
    .select({ name: sites.name, brief: sites.brief })
    .from(sites)
    .where(eq(sites.id, siteId));
  if (!site) {
    return c.json({ error: "Chat is not available" }, 404);
  }

  const siteName = site.name || "this website";
  const brief = (site.brief as SiteBrief | null) ?? null;
  const businessDescription = brief?.businessDescription?.trim() || "";
  const instructions = clampText(chatAddon.config.instructions, 4000).trim();

  const [pages, posts] = await Promise.all([
    db
      .select({ schemaData: content.schemaData })
      .from(content)
      .where(and(eq(content.siteId, siteId), eq(content.status, "published"), eq(content.type, "page")))
      .orderBy(desc(content.publishedAt))
      .limit(20),
    db
      .select({ schemaData: content.schemaData })
      .from(content)
      .where(and(eq(content.siteId, siteId), eq(content.status, "published"), eq(content.type, "post")))
      .orderBy(desc(content.publishedAt))
      .limit(10),
  ]);

  const pageLines = pages
    .map((p) => {
      const d = (p.schemaData as Record<string, unknown> | null) ?? {};
      const title = typeof d.title === "string" ? d.title.trim() : "";
      if (!title) return "";
      const summary =
        (typeof d.metaDescription === "string" && d.metaDescription.trim()) ||
        (typeof d.excerpt === "string" && d.excerpt.trim()) ||
        "";
      return summary ? `- ${title}: ${summary}` : `- ${title}`;
    })
    .filter(Boolean);

  const postLines = posts
    .map((p) => {
      const d = (p.schemaData as Record<string, unknown> | null) ?? {};
      const title = typeof d.title === "string" ? d.title.trim() : "";
      return title ? `- ${title}` : "";
    })
    .filter(Boolean);

  const contextParts: string[] = [
    `You are a friendly, helpful website assistant for ${siteName}. You chat with visitors browsing the site.`,
  ];
  if (businessDescription) {
    contextParts.push(`About ${siteName}:\n${businessDescription}`);
  }
  if (instructions) {
    contextParts.push(`Guidance from the site owner:\n${instructions}`);
  }
  if (pageLines.length > 0) {
    contextParts.push(`Pages on this website:\n${pageLines.join("\n")}`);
  }
  if (postLines.length > 0) {
    contextParts.push(`Recent posts:\n${postLines.join("\n")}`);
  }
  contextParts.push(
    [
      "Rules:",
      "- Answer ONLY using the business context above. Do not use outside knowledge about this business.",
      "- If you don't know the answer or it isn't covered by the context, say so plainly and suggest the visitor use the site's contact page to get in touch.",
      "- Never invent prices, policies, availability, hours, or contact details that aren't in the context.",
      "- Reply in 1-3 short paragraphs of plain text. Do not use markdown headings, bullet lists, tables, or code blocks.",
    ].join("\n"),
  );
  const systemPrompt = contextParts.join("\n\n");

  let prompt = "";
  for (const turn of history) {
    prompt += `${turn.role === "user" ? "Visitor" : "Assistant"}: ${turn.content}\n\n`;
  }
  prompt += `Visitor: ${message}\n\nAssistant:`;

  try {
    const result = await router.generateText({
      task: "visitor-chat",
      systemPrompt,
      prompt,
      temperature: 0.5,
      maxTokens: 500,
    });
    const reply = result.text?.trim();
    if (!reply) {
      return c.json({ error: "The assistant is unavailable right now." }, 503);
    }
    return c.json({ reply });
  } catch (err) {
    console.error("Visitor chat generation failed:", err instanceof Error ? err.message : err);
    return c.json({ error: "The assistant is unavailable right now." }, 503);
  }
});

// Redirect rules — consumed by the web app middleware to issue proper HTTP
// redirects before serving pages. Returns only enabled rules; no auth needed.
publicRoutes.get("/redirects", async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) return c.json({ items: [] });

  const items = await db
    .select({
      fromPath: redirects.fromPath,
      toUrl: redirects.toUrl,
      statusCode: redirects.statusCode,
    })
    .from(redirects)
    .where(and(eq(redirects.siteId, siteId), eq(redirects.enabled, true)));

  return c.json({ items });
});

// llms.txt — a curated markdown guide for LLMs (https://llmstxt.org). Served
// only for indexable (non-free) sites, mirroring the noindex rule. Returns a
// stored override when set, else a deterministic doc built from the brief +
// published content. The web app proxies this at the site root /llms.txt.
publicRoutes.get("/llms.txt", async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) return c.text("Not found", 404);

  const [site] = await db
    .select({
      name: sites.name,
      subdomain: sites.subdomain,
      domain: sites.domain,
      domainStatus: sites.domainStatus,
      plan: sites.plan,
      settings: sites.settings,
      brief: sites.brief,
    })
    .from(sites)
    .where(eq(sites.id, siteId));

  // Free tier is noindex — no llms.txt either, for the same reason.
  if (!site || site.plan === "free") return c.text("Not found", 404);

  const settings = (site.settings as Record<string, unknown> | null) ?? {};
  const seo = (settings.seo as Record<string, unknown> | undefined) ?? {};
  const override = typeof seo.llmsTxt === "string" ? seo.llmsTxt.trim() : "";

  let body: string;
  if (override) {
    body = override.endsWith("\n") ? override : override + "\n";
  } else {
    const [pages, posts] = await Promise.all([
      listPublishedForLlms(siteId, "page", 500),
      listPublishedForLlms(siteId, "post", 50),
    ]);
    body = buildLlmsTxt({
      siteName: site.name,
      origin: canonicalOrigin(site),
      brief: (site.brief as SiteBrief | null) ?? null,
      pages,
      posts,
    });
  }

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=900, s-maxage=900",
    },
  });
});

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function prettifyFieldKey(key: string): string {
  return key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}
