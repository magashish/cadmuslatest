import type { CustomHostnameProvider, CustomHostnameResult, CdnCacheProvider } from "../types.js";

export interface CloudflareCustomHostnameProviderConfig {
  apiToken: string;
  zoneId: string;
}

const CF_API = "https://api.cloudflare.com/client/v4";

export class CloudflareCustomHostnameProvider implements CustomHostnameProvider {
  private apiToken: string;
  private zoneId: string;

  constructor(config: CloudflareCustomHostnameProviderConfig) {
    this.apiToken = config.apiToken;
    this.zoneId = config.zoneId;
  }

  async create(hostname: string): Promise<CustomHostnameResult> {
    const res = await fetch(
      `${CF_API}/zones/${this.zoneId}/custom_hostnames`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          hostname,
          ssl: {
            method: "http",
            type: "dv",
            settings: {
              min_tls_version: "1.2",
            },
          },
          custom_origin_server: "origin.cadmus.digital",
        }),
      }
    );

    const data = await res.json() as CfResponse<CfCustomHostname>;
    if (!data.success) {
      return {
        id: "",
        status: "failed",
        sslStatus: "failed",
        errors: data.errors?.map((e) => e.message) || ["Unknown Cloudflare error"],
      };
    }

    return this.mapResult(data.result);
  }

  async getStatus(hostnameId: string): Promise<CustomHostnameResult> {
    const res = await fetch(
      `${CF_API}/zones/${this.zoneId}/custom_hostnames/${hostnameId}`,
      { headers: this.headers() }
    );

    const data = await res.json() as CfResponse<CfCustomHostname>;
    if (!data.success) {
      return {
        id: hostnameId,
        status: "failed",
        sslStatus: "failed",
        errors: data.errors?.map((e) => e.message) || ["Unknown Cloudflare error"],
      };
    }

    return this.mapResult(data.result);
  }

  async remove(hostnameId: string): Promise<void> {
    const res = await fetch(
      `${CF_API}/zones/${this.zoneId}/custom_hostnames/${hostnameId}`,
      { method: "DELETE", headers: this.headers() }
    );

    const data = await res.json() as CfResponse<unknown>;
    if (!data.success) {
      const msg = data.errors?.map((e) => e.message).join(", ") || "Unknown error";
      throw new Error(`Failed to remove custom hostname: ${msg}`);
    }
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiToken}`,
      "Content-Type": "application/json",
    };
  }

  private mapResult(cf: CfCustomHostname): CustomHostnameResult {
    const result: CustomHostnameResult = {
      id: cf.id,
      status: this.mapStatus(cf.status),
      sslStatus: this.mapSslStatus(cf.ssl?.status),
    };

    // Extract DCV CNAME validation record if present
    const dcvRecord = cf.ownership_verification;
    if (dcvRecord?.name && dcvRecord?.value) {
      result.verificationCname = { name: dcvRecord.name, value: dcvRecord.value };
    }

    return result;
  }

  private mapStatus(cfStatus: string): "pending" | "active" | "failed" {
    switch (cfStatus) {
      case "active":
        return "active";
      case "pending":
      case "moved":
      case "pending_deletion":
        return "pending";
      default:
        return "failed";
    }
  }

  private mapSslStatus(sslStatus?: string): "pending" | "active" | "failed" {
    if (!sslStatus) return "pending";
    switch (sslStatus) {
      case "active":
        return "active";
      case "pending_validation":
      case "pending_issuance":
      case "pending_deployment":
      case "initializing":
        return "pending";
      default:
        return "failed";
    }
  }
}

// ── CDN Cache Purge ─────────────────────────────────────────────────────────

export class CloudflareCdnCacheProvider implements CdnCacheProvider {
  private apiToken: string;
  private zoneId: string;

  constructor(config: CloudflareCustomHostnameProviderConfig) {
    this.apiToken = config.apiToken;
    this.zoneId = config.zoneId;
  }

  async purgeUrls(urls: string[]): Promise<void> {
    const batchSize = 30; // Cloudflare API limit per call
    for (let i = 0; i < urls.length; i += batchSize) {
      const batch = urls.slice(i, i + batchSize);
      try {
        const res = await fetch(
          `${CF_API}/zones/${this.zoneId}/purge_cache`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.apiToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ files: batch }),
          }
        );
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          // Single-line JSON: Cloud Run splits multi-line writes into one log
          // entry PER LINE, which shreds util.inspect object output into
          // meaningless fragments in the log viewer.
          console.error(`[cdn-cache] Purge failed: ${res.status} ${JSON.stringify(data)}`);
        }
      } catch (err) {
        console.error("[cdn-cache] Purge request error:", err);
      }
    }
  }
}

// Cloudflare API response types (minimal)
interface CfResponse<T> {
  success: boolean;
  result: T;
  errors?: { code: number; message: string }[];
}

interface CfCustomHostname {
  id: string;
  hostname: string;
  status: string;
  ssl?: { status: string };
  ownership_verification?: { name: string; value: string };
}
