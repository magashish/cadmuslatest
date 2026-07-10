import { Logging } from "@google-cloud/logging";
import type { LogsProvider, LogsQuery, LogsQueryResult, LogEntryRecord } from "../types.js";

export interface GcpLogsProviderConfig {
  projectId?: string;
}

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;
const DEFAULT_SINCE_MINUTES = 60;
const MESSAGE_MAX_CHARS = 2000;

// Cloud Logging severity ordering, used only for informational purposes; the
// actual >= comparison is done server-side by the `severity>=LEVEL` filter.
export class GcpLogsProvider implements LogsProvider {
  private logging: Logging;

  constructor(config: GcpLogsProviderConfig = {}) {
    // ADC by default (same as the GCS provider) — on Cloud Run this resolves to
    // the service account's credentials with no key file.
    this.logging = new Logging({ projectId: config.projectId });
  }

  async query(opts: LogsQuery): Promise<LogsQueryResult> {
    const sinceMinutes = opts.sinceMinutes ?? DEFAULT_SINCE_MINUTES;
    const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    // A page token is only valid against the exact filter that produced it, so
    // paginated calls must reuse the original window start instead of "now - N".
    const sinceIso = opts.sinceIso ?? new Date(Date.now() - sinceMinutes * 60_000).toISOString();

    const filterParts = [
      `resource.type="cloud_run_revision"`,
      `resource.labels.service_name="${opts.service}"`,
      `timestamp>="${sinceIso}"`,
    ];
    if (opts.severityMin) {
      filterParts.push(`severity>=${opts.severityMin}`);
    }
    if (opts.q) {
      // Bare quoted term = global restriction: Cloud Logging searches all
      // fields of the entry for the phrase. Escape embedded double quotes.
      const escaped = opts.q.replace(/"/g, '\\"');
      filterParts.push(`"${escaped}"`);
    }
    const filter = filterParts.join(" AND ");

    // With autoPaginate off, the second tuple element is the options for the
    // next page (present only when more entries match).
    const [entries, nextQuery] = await this.logging.getEntries({
      filter,
      orderBy: "timestamp desc",
      pageSize: limit,
      autoPaginate: false,
      ...(opts.pageToken ? { pageToken: opts.pageToken } : {}),
    });

    const nextPageToken = (nextQuery as { pageToken?: string } | null | undefined)?.pageToken;
    return {
      entries: entries.slice(0, limit).map((entry) => this.mapEntry(entry, opts.service)),
      ...(nextPageToken ? { nextPageToken } : {}),
      sinceIso,
    };
  }

  private mapEntry(entry: unknown, fallbackService: string): LogEntryRecord {
    const e = entry as {
      metadata?: {
        timestamp?: unknown;
        severity?: unknown;
        trace?: string;
        resource?: { labels?: Record<string, string> };
        httpRequest?: {
          requestMethod?: string;
          requestUrl?: string;
          status?: number;
          latency?: unknown;
          userAgent?: string;
          remoteIp?: string;
        };
        textPayload?: unknown;
        jsonPayload?: unknown;
      };
      data?: unknown;
    };
    const meta = e.metadata ?? {};

    // GCP audit/system entries (deploys, revision rollouts, IAM changes) carry
    // a protobuf payload — an Any of type_url + raw bytes we can't decode.
    // Stringifying it dumps useless Buffer byte arrays, so label it instead.
    const anyPayload = e.data as { type_url?: unknown } | null | undefined;
    if (anyPayload && typeof anyPayload.type_url === "string") {
      const kind = anyPayload.type_url.endsWith("AuditLog") ? "audit event" : "system event";
      return {
        timestamp: toIso(meta.timestamp),
        severity: toSeverity(meta.severity),
        service: meta.resource?.labels?.service_name ?? fallbackService,
        message: `(${kind} — check the GCP console for details)`,
        ...(meta.trace ? { trace: meta.trace } : {}),
      };
    }

    // Payload first (app stdout/stderr); fall back to raw metadata payload
    // fields for library versions that don't decode into .data.
    let message = toMessage(e.data) || toMessage(meta.textPayload) || toMessage(meta.jsonPayload);

    // Cloud Run REQUEST logs (run.googleapis.com/requests) have no payload at
    // all — their substance is the httpRequest metadata. Synthesize a readable
    // access-log line so these rows aren't blank.
    if (!message && meta.httpRequest) {
      const r = meta.httpRequest;
      let path = r.requestUrl ?? "";
      try {
        if (path) path = new URL(path).pathname + new URL(path).search;
      } catch {
        // keep the raw URL if it doesn't parse
      }
      const latency = toLatencyMs(r.latency);
      message = [r.requestMethod ?? "?", path || "?", "→", String(r.status ?? "?"), latency ? `(${latency})` : ""]
        .filter(Boolean)
        .join(" ");
    }

    // Surface who sent the request (full URL incl. host, caller IP, UA) — the
    // synthesized message strips the host and omits these entirely.
    let httpRequest: LogEntryRecord["httpRequest"];
    if (meta.httpRequest) {
      const r = meta.httpRequest;
      httpRequest = {
        ...(r.requestUrl ? { requestUrl: r.requestUrl } : {}),
        ...(r.remoteIp ? { remoteIp: r.remoteIp } : {}),
        ...(r.userAgent ? { userAgent: truncate(r.userAgent) } : {}),
      };
    }

    return {
      timestamp: toIso(meta.timestamp),
      severity: toSeverity(meta.severity),
      service: meta.resource?.labels?.service_name ?? fallbackService,
      message,
      ...(meta.trace ? { trace: meta.trace } : {}),
      ...(httpRequest && Object.keys(httpRequest).length > 0 ? { httpRequest } : {}),
    };
  }
}

// httpRequest.latency arrives as "0.080579s" (REST) or { seconds, nanos } (gRPC).
function toLatencyMs(latency: unknown): string {
  if (typeof latency === "string") {
    const secs = parseFloat(latency);
    return Number.isFinite(secs) ? `${Math.round(secs * 1000)}ms` : "";
  }
  if (latency && typeof latency === "object" && "seconds" in latency) {
    const l = latency as { seconds?: number | string; nanos?: number };
    const ms = Number(l.seconds ?? 0) * 1000 + Math.round((l.nanos ?? 0) / 1e6);
    return `${ms}ms`;
  }
  return "";
}

function toIso(ts: unknown): string {
  if (!ts) return new Date(0).toISOString();
  if (ts instanceof Date) return ts.toISOString();
  if (typeof ts === "string") return new Date(ts).toISOString();
  // Protobuf Timestamp { seconds, nanos }
  if (typeof ts === "object" && ts !== null && "seconds" in ts) {
    const t = ts as { seconds: number | string; nanos?: number };
    const seconds = Number(t.seconds);
    const millis = seconds * 1000 + Math.floor((t.nanos ?? 0) / 1e6);
    return new Date(millis).toISOString();
  }
  return new Date(0).toISOString();
}

function toSeverity(sev: unknown): string {
  if (typeof sev === "string" && sev.length > 0) return sev;
  if (typeof sev === "number") return String(sev);
  return "DEFAULT";
}

function toMessage(data: unknown): string {
  if (typeof data === "string") return data;
  if (data && typeof data === "object") {
    const obj = data as { message?: unknown };
    if (typeof obj.message === "string") return truncate(obj.message);
    return truncate(JSON.stringify(data));
  }
  if (data == null) return "";
  return truncate(String(data));
}

function truncate(s: string): string {
  return s.length > MESSAGE_MAX_CHARS ? s.slice(0, MESSAGE_MAX_CHARS) + "…" : s;
}
