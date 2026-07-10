import crypto from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, formSubmissions, sites, contentBlocks, content } from "@cadmus/db";
import { safeFetch, SsrfError } from "./safe-fetch.js";

const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 10_000;

export interface FormWebhookPayload {
  event: "form.submission";
  siteId: string;
  submissionId: string;
  formIdentifier: string;
  formName?: string;
  fields: Record<string, string>;
  // Attachment metadata only (form-file-uploads add-on) — no storage paths or
  // URLs; receivers direct users to the Forms page for the files themselves.
  attachments?: Array<{ filename: string; size: number; contentType: string }>;
  submitterEmail: string | null;
  sourceUrl: string | null;
  submittedAt: string;
}

// HMAC-SHA256 over "<timestamp>.<body>" so the receiver can verify authenticity
// and reject replays. Sent as the X-Cadmus-Signature header.
function sign(secret: string, body: string, timestamp: string): string {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

// One signing secret per site, lazily generated and persisted in
// settings.formDefaults.webhookSecret. Server-only — stripped from the public
// /site response. Returns null if the site doesn't exist.
export async function ensureSiteWebhookSecret(siteId: string): Promise<string | null> {
  const [site] = await db.select({ settings: sites.settings }).from(sites).where(eq(sites.id, siteId));
  if (!site) return null;
  const settings = (site.settings ?? {}) as Record<string, unknown>;
  const formDefaults = (settings.formDefaults ?? {}) as Record<string, unknown>;
  if (typeof formDefaults.webhookSecret === "string" && formDefaults.webhookSecret) {
    return formDefaults.webhookSecret;
  }
  return writeWebhookSecret(siteId, settings, formDefaults);
}

// Generates a fresh secret and overwrites the existing one. The old secret stops
// working immediately (we only sign+send — no dual-signing grace window), so the
// receiver must be updated. Returns the new secret, or null if the site is gone.
export async function rotateSiteWebhookSecret(siteId: string): Promise<string | null> {
  const [site] = await db.select({ settings: sites.settings }).from(sites).where(eq(sites.id, siteId));
  if (!site) return null;
  const settings = (site.settings ?? {}) as Record<string, unknown>;
  const formDefaults = (settings.formDefaults ?? {}) as Record<string, unknown>;
  return writeWebhookSecret(siteId, settings, formDefaults);
}

async function writeWebhookSecret(
  siteId: string,
  settings: Record<string, unknown>,
  formDefaults: Record<string, unknown>,
): Promise<string> {
  const secret = `whsec_${crypto.randomBytes(24).toString("hex")}`;
  await db
    .update(sites)
    .set({ settings: { ...settings, formDefaults: { ...formDefaults, webhookSecret: secret } } })
    .where(eq(sites.id, siteId));
  return secret;
}

// Delivers a form-submission webhook with retry, recording the outcome on the
// submission row. Safe to call without awaiting (fire-and-forget) — it never
// throws. URL must be https; SSRF/internal targets are blocked by safeFetch.
export async function deliverFormWebhook(opts: {
  submissionId: string;
  url: string;
  secret: string;
  payload: FormWebhookPayload;
}): Promise<void> {
  const { submissionId, url, secret, payload } = opts;

  if (!/^https:\/\//i.test(url.trim())) {
    await markFailed(submissionId, 0, "Webhook URL must use https");
    return;
  }

  const body = JSON.stringify(payload);
  let lastError = "";
  let attempts = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    attempts = attempt;
    try {
      const timestamp = String(Date.now());
      const res = await safeFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Cadmus-Webhook/1.0",
          "X-Cadmus-Event": payload.event,
          "X-Cadmus-Timestamp": timestamp,
          "X-Cadmus-Signature": sign(secret, body, timestamp),
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) {
        await db
          .update(formSubmissions)
          .set({ webhookStatus: "success", webhookAttempts: attempt, webhookError: null, webhookUpdatedAt: new Date() })
          .where(eq(formSubmissions.id, submissionId));
        return;
      }
      lastError = `HTTP ${res.status}`;
      // Client errors (except 408/429) won't change on retry — stop early.
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) break;
    } catch (err) {
      if (err instanceof SsrfError) {
        await markFailed(submissionId, attempt, `Blocked URL: ${err.message}`);
        return; // never retry a blocked/internal target
      }
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }

  await markFailed(submissionId, attempts, lastError);
}

// Resolves the webhook target for a form: per-form config on the block (FormBlock
// at top level, HtmlBlock under formSettings), falling back to the site-level
// formDefaults. Scoped to siteId so a cross-tenant form id can't resolve config.
export async function resolveFormWebhookConfig(
  siteId: string,
  formIdentifier: string,
): Promise<{ url?: string; enabled: boolean; formName?: string }> {
  let url: string | undefined;
  let enabled = false;
  let formName: string | undefined;

  if (formIdentifier.startsWith("form:") || formIdentifier.startsWith("block:")) {
    const isFormId = formIdentifier.startsWith("form:");
    const id = formIdentifier.slice(isFormId ? 5 : 6);
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
      const fs = (d.formSettings as Record<string, unknown> | undefined) ?? d;
      if (typeof fs.webhookUrl === "string") url = fs.webhookUrl;
      enabled = fs.webhookEnabled === true;
      formName = typeof fs.name === "string" ? fs.name : undefined;
    }
  }

  if (!url) {
    const [site] = await db.select({ settings: sites.settings }).from(sites).where(eq(sites.id, siteId));
    const defaults = (site?.settings as Record<string, unknown> | undefined)?.formDefaults as Record<string, unknown> | undefined;
    if (defaults && typeof defaults.webhookUrl === "string") {
      url = defaults.webhookUrl;
      enabled = defaults.webhookEnabled === true;
    }
  }

  return { url, enabled, formName };
}

async function markFailed(submissionId: string, attempts: number, error: string): Promise<void> {
  await db
    .update(formSubmissions)
    .set({ webhookStatus: "failed", webhookAttempts: attempts, webhookError: error.slice(0, 500), webhookUpdatedAt: new Date() })
    .where(eq(formSubmissions.id, submissionId));
}
