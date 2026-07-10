import { Hono } from "hono";
import type { LogsProvider } from "@cadmus/cloud";
import type { AuthUser } from "@cadmus/shared";
import { logError } from "../lib/log.js";

// Staff-only Cloud Run logs viewer. Mounted under /api/admin, whose middleware
// already enforces the cadmus_admin global role — no extra auth here.
export const adminLogsRoutes = new Hono<{ Variables: { user: AuthUser } }>();

let logsProvider: LogsProvider | null = null;
export function setLogsProvider(provider: LogsProvider): void {
  logsProvider = provider;
}

// Allowlist of Cloud Run services staff may inspect. Anything else is a 400 —
// the service name goes straight into a Cloud Logging filter, so we never
// forward an unvetted value.
// Matches the actual Cloud Run services. The admin/dashboard SPAs are served
// as static assets via the worker — they have no Cloud Run service or logs.
const SERVICE_ALLOWLIST = [
  "cadmus-api",
  "cadmus-api-dev",
  "cadmus-web",
  "cadmus-web-dev",
  "cadmus-scanner",
  "cadmus-scanner-dev",
];
const DEFAULT_SERVICE = "cadmus-api";

const SEVERITY_ALLOWLIST = ["DEBUG", "INFO", "WARNING", "ERROR"];

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

// The client cursor bundles Cloud Logging's page token with the exact window
// start of the first page — a page token is only valid against an identical
// filter, so "now - N minutes" can't be recomputed on later pages.
function encodeCursor(pageToken: string, sinceIso: string): string {
  return Buffer.from(JSON.stringify({ pt: pageToken, since: sinceIso })).toString("base64url");
}

function decodeCursor(cursor: string): { pt: string; since: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      pt?: unknown;
      since?: unknown;
    };
    if (typeof parsed.pt === "string" && typeof parsed.since === "string") {
      return { pt: parsed.pt, since: parsed.since };
    }
  } catch {
    // malformed cursor — treated as invalid below
  }
  return null;
}

adminLogsRoutes.get("/logs", async (c) => {
  if (!logsProvider) {
    return c.json({ error: "Logs provider not configured" }, 503);
  }

  const service = c.req.query("service") ?? DEFAULT_SERVICE;
  if (!SERVICE_ALLOWLIST.includes(service)) {
    return c.json({ error: `Unknown service: ${service}` }, 400);
  }

  const severity = c.req.query("severity");
  if (severity && !SEVERITY_ALLOWLIST.includes(severity)) {
    return c.json({ error: `Invalid severity: ${severity}` }, 400);
  }

  const rawQ = c.req.query("q");
  const q = rawQ ? rawQ.slice(0, 200) : undefined;

  const sinceRaw = Number(c.req.query("sinceMinutes"));
  const sinceMinutes = Number.isFinite(sinceRaw) && sinceRaw > 0 ? clamp(sinceRaw, 5, 1440) : 60;

  const limitRaw = Number(c.req.query("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? clamp(limitRaw, 10, 500) : 100;

  const rawCursor = c.req.query("cursor");
  const cursor = rawCursor ? decodeCursor(rawCursor) : null;
  if (rawCursor && !cursor) {
    return c.json({ error: "Invalid cursor" }, 400);
  }

  try {
    const result = await logsProvider.query({
      service,
      severityMin: severity,
      q,
      sinceMinutes,
      ...(cursor ? { sinceIso: cursor.since, pageToken: cursor.pt } : {}),
      limit,
    });
    return c.json({
      entries: result.entries,
      ...(result.nextPageToken
        ? { nextCursor: encodeCursor(result.nextPageToken, result.sinceIso) }
        : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Log server-side too: the browser-facing body can be swallowed by
    // intermediary error pages, and this is the log-viewing feature itself —
    // when it breaks, Cloud Logging is the only place to see why.
    logError(`[admin-logs] query failed (service=${c.req.query("service") ?? "cadmus-api"})`, err);
    const hint = /permission|denied|forbidden|PERMISSION_DENIED/i.test(message)
      ? " — the API service account likely needs roles/logging.viewer"
      : "";
    return c.json({ error: `Failed to query logs: ${message}${hint}` }, 503);
  }
});
