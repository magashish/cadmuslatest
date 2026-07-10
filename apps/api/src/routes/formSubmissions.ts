import { Readable } from "node:stream";
import { Hono } from "hono";
import type { Context } from "hono";
import { eq, and, desc, sql, gte, lte, ilike, or, inArray } from "drizzle-orm";
import { db, formSubmissions, contentBlocks } from "@cadmus/db";
import type { SiteEnv } from "../middleware/tenant.js";
import { ensureSiteWebhookSecret, rotateSiteWebhookSecret, deliverFormWebhook, resolveFormWebhookConfig } from "../lib/form-webhook.js";
import { getFormUploadsStorage } from "../lib/form-uploads.js";

export const formSubmissionRoutes = new Hono<SiteEnv>();

// Resolve friendly names for a set of form identifiers. `form:<uuid>` looks up
// by formId in the block's data JSON (survives content saves). Legacy
// `block:<uuid>` looks up by the block's primary key. Returns a map from
// the full identifier (e.g. "form:abc...") to its display name, omitting
// entries that have no name.
async function resolveFormNames(identifiers: string[]): Promise<Map<string, string>> {
  const nameByIdentifier = new Map<string, string>();
  const formIds = identifiers
    .map((id) => (id.startsWith("form:") ? id.slice(5) : null))
    .filter((id): id is string => !!id);
  const blockIds = identifiers
    .map((id) => (id.startsWith("block:") ? id.slice(6) : null))
    .filter((id): id is string => !!id);

  const extractName = (blockType: string, data: Record<string, unknown>): string | undefined => {
    const name =
      blockType === "html"
        ? (data.formSettings as { name?: string } | undefined)?.name
        : (data.name as string | undefined);
    return typeof name === "string" && name.trim() ? name.trim() : undefined;
  };

  if (formIds.length > 0) {
    const blocks = await db
      .select({ blockType: contentBlocks.blockType, data: contentBlocks.data })
      .from(contentBlocks)
      .where(
        or(
          inArray(sql`${contentBlocks.data}->>'formId'`, formIds),
          inArray(sql`${contentBlocks.data}->'formSettings'->>'formId'`, formIds),
        ),
      );
    for (const block of blocks) {
      const data = (block.data ?? {}) as Record<string, unknown>;
      const formId =
        block.blockType === "html"
          ? (data.formSettings as { formId?: string } | undefined)?.formId
          : (data.formId as string | undefined);
      if (!formId) continue;
      const name = extractName(block.blockType, data);
      if (name) nameByIdentifier.set(`form:${formId}`, name);
    }
  }

  if (blockIds.length > 0) {
    const blocks = await db
      .select({ id: contentBlocks.id, blockType: contentBlocks.blockType, data: contentBlocks.data })
      .from(contentBlocks)
      .where(inArray(contentBlocks.id, blockIds));
    for (const block of blocks) {
      const data = (block.data ?? {}) as Record<string, unknown>;
      const name = extractName(block.blockType, data);
      if (name) nameByIdentifier.set(`block:${block.id}`, name);
    }
  }

  return nameByIdentifier;
}

function buildFilters(c: Context<SiteEnv>) {
  const siteId = c.get("site")?.siteId;
  const form = c.req.query("form");
  const from = c.req.query("from");
  const to = c.req.query("to");
  const search = c.req.query("search");

  const conditions = [eq(formSubmissions.siteId, siteId!)];
  if (form) conditions.push(eq(formSubmissions.formIdentifier, form));
  if (from) {
    const fromDate = new Date(from);
    if (!isNaN(fromDate.getTime())) conditions.push(gte(formSubmissions.createdAt, fromDate));
  }
  if (to) {
    const toDate = new Date(to);
    if (!isNaN(toDate.getTime())) conditions.push(lte(formSubmissions.createdAt, toDate));
  }
  if (search) {
    const like = `%${search}%`;
    const searchCond = or(
      ilike(formSubmissions.submitterEmail, like),
      ilike(formSubmissions.sourceUrl, like),
      sql`${formSubmissions.data}::text ILIKE ${like}`,
    );
    if (searchCond) conditions.push(searchCond);
  }
  return conditions;
}

// List submissions (paginated, filterable by formIdentifier, date range, search)
formSubmissionRoutes.get("/", async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) return c.json({ error: "Site context is required" }, 400);

  const limit = Math.min(Number(c.req.query("limit")) || 50, 100);
  const offset = Number(c.req.query("offset")) || 0;
  const conditions = buildFilters(c);

  const [items, countResult] = await Promise.all([
    db
      .select()
      .from(formSubmissions)
      .where(and(...conditions))
      .orderBy(desc(formSubmissions.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)` })
      .from(formSubmissions)
      .where(and(...conditions)),
  ]);

  return c.json({ items, total: Number(countResult[0].count) });
});

// Export submissions as CSV (same filters as list, no pagination)
formSubmissionRoutes.get("/export.csv", async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) return c.json({ error: "Site context is required" }, 400);

  const conditions = buildFilters(c);

  const rows = await db
    .select()
    .from(formSubmissions)
    .where(and(...conditions))
    .orderBy(desc(formSubmissions.createdAt))
    .limit(10000);

  const dataKeys = new Set<string>();
  for (const row of rows) {
    const data = (row.data ?? {}) as Record<string, unknown>;
    for (const k of Object.keys(data)) dataKeys.add(k);
  }
  const dataCols = [...dataKeys].sort();

  const uniqueIdentifiers = [...new Set(rows.map((r) => r.formIdentifier))];
  const nameByIdentifier = await resolveFormNames(uniqueIdentifiers);

  const headers = ["submitted_at", "form", "email", "source_url", "ip", ...dataCols];
  const escape = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(escape).join(",")];
  for (const row of rows) {
    const data = (row.data ?? {}) as Record<string, unknown>;
    const formName = nameByIdentifier.get(row.formIdentifier) ?? row.formIdentifier;
    lines.push(
      [
        row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
        formName,
        row.submitterEmail ?? "",
        row.sourceUrl ?? "",
        row.ipAddress ?? "",
        ...dataCols.map((k) => data[k] ?? ""),
      ]
        .map(escape)
        .join(","),
    );
  }
  const csv = lines.join("\n");
  const ts = new Date().toISOString().slice(0, 10);

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="form-submissions-${ts}.csv"`,
    },
  });
});

// Get distinct form identifiers for filter dropdown
formSubmissionRoutes.get("/forms", async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) return c.json({ error: "Site context is required" }, 400);

  const result = await db
    .select({
      formIdentifier: formSubmissions.formIdentifier,
      count: sql<number>`count(*)`,
    })
    .from(formSubmissions)
    .where(eq(formSubmissions.siteId, siteId))
    .groupBy(formSubmissions.formIdentifier);

  // Resolve friendly names. `form:<uuid>` identifiers look up by formId in the
  // block's data JSON (survives content saves). Legacy `block:<uuid>` identifiers
  // look up by the block's primary key.
  const formIds = result
    .map((r) => r.formIdentifier.startsWith("form:") ? r.formIdentifier.slice(5) : null)
    .filter((id): id is string => !!id);
  const blockIds = result
    .map((r) => r.formIdentifier.startsWith("block:") ? r.formIdentifier.slice(6) : null)
    .filter((id): id is string => !!id);

  const nameByFormId = new Map<string, string>();
  const nameByBlockId = new Map<string, string>();

  function extractName(blockType: string, data: Record<string, unknown>): string | undefined {
    const name =
      blockType === "html"
        ? ((data.formSettings as { name?: string } | undefined)?.name)
        : (data.name as string | undefined);
    return typeof name === "string" && name.trim() ? name.trim() : undefined;
  }

  if (formIds.length > 0) {
    const blocks = await db
      .select({ blockType: contentBlocks.blockType, data: contentBlocks.data })
      .from(contentBlocks)
      .where(
        or(
          inArray(sql`${contentBlocks.data}->>'formId'`, formIds),
          inArray(sql`${contentBlocks.data}->'formSettings'->>'formId'`, formIds),
        ),
      );
    for (const block of blocks) {
      const data = (block.data ?? {}) as Record<string, unknown>;
      const formId =
        block.blockType === "html"
          ? ((data.formSettings as { formId?: string } | undefined)?.formId)
          : (data.formId as string | undefined);
      if (!formId) continue;
      const name = extractName(block.blockType, data);
      if (name) nameByFormId.set(formId, name);
    }
  }

  if (blockIds.length > 0) {
    const blocks = await db
      .select({ id: contentBlocks.id, blockType: contentBlocks.blockType, data: contentBlocks.data })
      .from(contentBlocks)
      .where(inArray(contentBlocks.id, blockIds));
    for (const block of blocks) {
      const data = (block.data ?? {}) as Record<string, unknown>;
      const name = extractName(block.blockType, data);
      if (name) nameByBlockId.set(block.id, name);
    }
  }

  const forms = result.map((r) => {
    let name: string | null = null;
    if (r.formIdentifier.startsWith("form:")) {
      name = nameByFormId.get(r.formIdentifier.slice(5)) ?? null;
    } else if (r.formIdentifier.startsWith("block:")) {
      name = nameByBlockId.get(r.formIdentifier.slice(6)) ?? null;
    }
    return { formIdentifier: r.formIdentifier, count: r.count, name };
  });

  return c.json({ forms });
});

// Reveal (and lazily create) the site's webhook signing secret. The receiver
// uses it to verify the X-Cadmus-Signature header. Registered before /:id so
// the static path isn't captured by the :id param route.
formSubmissionRoutes.get("/webhook-secret", async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) return c.json({ error: "Site context is required" }, 400);
  const secret = await ensureSiteWebhookSecret(siteId);
  return c.json({ secret });
});

// Rotate the signing secret. The old secret stops working immediately.
formSubmissionRoutes.post("/webhook-secret/rotate", async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) return c.json({ error: "Site context is required" }, 400);
  const secret = await rotateSiteWebhookSecret(siteId);
  return c.json({ secret });
});

// Re-fire the webhook for a submission (e.g. after the receiver was down).
// Awaits delivery so the response reflects the new status.
formSubmissionRoutes.post("/:id/resend-webhook", async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) return c.json({ error: "Site context is required" }, 400);

  const id = c.req.param("id");
  const [item] = await db
    .select()
    .from(formSubmissions)
    .where(and(eq(formSubmissions.id, id), eq(formSubmissions.siteId, siteId)));
  if (!item) return c.json({ error: "Submission not found" }, 404);

  const config = await resolveFormWebhookConfig(siteId, item.formIdentifier);
  if (!config.url || !config.enabled) {
    return c.json({ error: "No webhook is configured for this form" }, 400);
  }
  const secret = await ensureSiteWebhookSecret(siteId);
  if (!secret) return c.json({ error: "Could not load signing secret" }, 500);

  await db.update(formSubmissions).set({ webhookStatus: "pending" }).where(eq(formSubmissions.id, id));
  await deliverFormWebhook({
    submissionId: id,
    url: config.url,
    secret,
    payload: {
      event: "form.submission",
      siteId,
      submissionId: id,
      formIdentifier: item.formIdentifier,
      formName: config.formName,
      fields: (item.data ?? {}) as Record<string, string>,
      submitterEmail: item.submitterEmail ?? null,
      sourceUrl: item.sourceUrl ?? null,
      submittedAt: (item.createdAt instanceof Date ? item.createdAt : new Date()).toISOString(),
    },
  });

  const [updated] = await db.select().from(formSubmissions).where(eq(formSubmissions.id, id));
  return c.json({ submission: updated });
});

// Download a submission attachment (form-file-uploads add-on). Streams the
// object from the private form-uploads bucket via the SA access token — no
// signBlob, so it works on Cloud Run's keyless service accounts.
formSubmissionRoutes.get("/:id/attachments/:index/download", async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) return c.json({ error: "Site context is required" }, 400);

  const id = c.req.param("id");
  const index = Number(c.req.param("index"));
  const [item] = await db
    .select({ attachments: formSubmissions.attachments })
    .from(formSubmissions)
    .where(and(eq(formSubmissions.id, id), eq(formSubmissions.siteId, siteId)));
  if (!item) return c.json({ error: "Submission not found" }, 404);

  const attachments = (item.attachments ?? []) as Array<{
    filename?: string;
    path?: string;
    contentType?: string;
  }>;
  const att = Number.isInteger(index) ? attachments[index] : undefined;
  if (!att?.path) return c.json({ error: "Attachment not found" }, 404);
  // Defense in depth: a stored path must stay inside this site's prefix.
  if (!att.path.startsWith(`${siteId}/`)) return c.json({ error: "Attachment not found" }, 404);

  const storage = getFormUploadsStorage();
  if (!storage) return c.json({ error: "File uploads are not configured" }, 503);

  let obj;
  try {
    obj = await storage.streamObject(att.path);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("No such object")) return c.json({ error: "File no longer available" }, 410);
    throw err;
  }

  const filename = (att.filename || "attachment").replace(/"/g, "");
  return c.body(Readable.toWeb(obj.stream) as ReadableStream, 200, {
    "Content-Type": att.contentType || obj.contentType || "application/octet-stream",
    "Content-Length": String(obj.size),
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "private, no-store",
  });
});

// Get single submission
formSubmissionRoutes.get("/:id", async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) return c.json({ error: "Site context is required" }, 400);

  const id = c.req.param("id");
  const [item] = await db
    .select()
    .from(formSubmissions)
    .where(and(eq(formSubmissions.id, id), eq(formSubmissions.siteId, siteId)));

  if (!item) return c.json({ error: "Submission not found" }, 404);
  return c.json(item);
});

// Delete submission
formSubmissionRoutes.delete("/:id", async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) return c.json({ error: "Site context is required" }, 400);

  const id = c.req.param("id");
  const [deleted] = await db
    .delete(formSubmissions)
    .where(and(eq(formSubmissions.id, id), eq(formSubmissions.siteId, siteId)))
    .returning({ attachments: formSubmissions.attachments });

  // Best-effort: clean up stored attachment objects so the private bucket
  // doesn't accumulate orphans. A failure here doesn't fail the delete.
  const storage = getFormUploadsStorage();
  const attachments = (deleted?.attachments ?? []) as Array<{ path?: string }>;
  if (storage && attachments.length > 0) {
    void Promise.allSettled(
      attachments
        .filter((a) => typeof a.path === "string" && a.path.startsWith(`${siteId}/`))
        .map((a) => storage.delete(a.path!)),
    );
  }

  return c.json({ success: true });
});
