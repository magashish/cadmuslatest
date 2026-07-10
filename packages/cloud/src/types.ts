// ── Storage ─────────────────────────────────────────────────────────────────

import type { Readable } from "node:stream";

export interface StorageUploadResult {
  path: string;
  url: string;
  size: number;
}

export interface StorageObjectStream {
  stream: Readable;
  size: number; // total object size, regardless of requested range
  contentType: string;
}

export interface StorageProvider {
  upload(
    file: Buffer,
    path: string,
    contentType?: string,
    cacheControl?: string,
  ): Promise<StorageUploadResult>;
  delete(path: string): Promise<void>;
  getSignedUrl(path: string, expiresInSeconds: number): Promise<string>;
  getSignedUploadUrl(path: string, contentType: string, expiresInSeconds: number): Promise<string>;
  // Resumable upload session for direct browser->GCS upload. Unlike signed
  // URLs it makes no signBlob call (uses the SA access token), so it works on
  // Cloud Run where keyless signing is unreliable. `origin` is the browser
  // origin that will PUT to the session (recorded for CORS).
  createResumableUploadUrl(path: string, contentType: string, origin?: string): Promise<string>;
  // Stream an object's bytes (optionally a byte range) using the SA access
  // token — no signBlob, so it works on Cloud Run. Used to proxy private
  // staging media to the browser. `range.end` is inclusive (HTTP semantics).
  streamObject(path: string, range?: { start: number; end?: number }): Promise<StorageObjectStream>;
  getPublicUrl(path: string): string;
  // Actual stored byte size of an object (used to verify a direct upload
  // against limits/quota — the client-declared size is not trustworthy).
  getObjectSize(path: string): Promise<number>;
  copyFile(sourcePath: string, destPath: string, sourceBucketName?: string): Promise<StorageUploadResult>;
  ping(): Promise<void>;
}

// ── Scheduling ──────────────────────────────────────────────────────────────

export interface ScheduledJob {
  id: string;
  schedule?: string; // cron expression for recurring
  runAt?: Date;      // specific time for one-time
  endpoint: string;  // URL to call when triggered
  payload?: unknown;
}

export interface SchedulerProvider {
  create(job: Omit<ScheduledJob, "id">): Promise<ScheduledJob>;
  cancel(jobId: string): Promise<void>;
  list(): Promise<ScheduledJob[]>;
}

// ── Custom Hostnames ────────────────────────────────────────────────────────

export interface CustomHostnameResult {
  id: string;
  status: "pending" | "active" | "failed";
  sslStatus: "pending" | "active" | "failed";
  verificationCname?: { name: string; value: string };
  errors?: string[];
}

export interface CustomHostnameProvider {
  create(hostname: string): Promise<CustomHostnameResult>;
  getStatus(hostnameId: string): Promise<CustomHostnameResult>;
  remove(hostnameId: string): Promise<void>;
}

// ── CDN Cache ──────────────────────────────────────────────────────────────

export interface CdnCacheProvider {
  purgeUrls(urls: string[]): Promise<void>;
}

// ── Email ───────────────────────────────────────────────────────────────────

export interface EmailMessage {
  to: string;
  from: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
}

export interface EmailSendResult {
  id: string;
  success: boolean;
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<EmailSendResult>;
}

// ── Logs ──────────────────────────────────────────────────────────────────────

export interface LogEntryRecord {
  timestamp: string;        // ISO
  severity: string;         // DEFAULT|DEBUG|INFO|NOTICE|WARNING|ERROR|CRITICAL...
  service: string;          // cloud run service name
  message: string;          // textPayload or stringified jsonPayload message
  trace?: string;
  // Request metadata, present on request-type entries (e.g. Cloud Run request logs)
  httpRequest?: {
    requestUrl?: string;    // full URL including host
    remoteIp?: string;
    userAgent?: string;
  };
}

export interface LogsQuery {
  service: string;          // required: cloud run service name
  severityMin?: string;     // e.g. "WARNING" — filter to >= this severity
  q?: string;               // free-text search within payload
  sinceMinutes?: number;    // default 60
  sinceIso?: string;        // exact window start — overrides sinceMinutes. Required
                            // when paginating: the filter must be byte-identical
                            // across pages or the page token is rejected.
  limit?: number;           // default 100, max 500
  pageToken?: string;       // continue a previous query
}

export interface LogsQueryResult {
  entries: LogEntryRecord[];
  nextPageToken?: string;   // present when more entries match
  sinceIso: string;         // the window start actually used (echo back with pageToken)
}

export interface LogsProvider {
  query(opts: LogsQuery): Promise<LogsQueryResult>;
}

// ── Secrets ─────────────────────────────────────────────────────────────────

export interface SecretsProvider {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
