import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// SSRF guard for server-side fetches of user-supplied URLs (importers,
// image re-hosting, font mirroring). Without this, a user could point the
// platform at the GCP metadata server (169.254.169.254) to steal the Cloud
// Run service account token, or scan/hit internal services (Cloud SQL,
// 10.x ranges, localhost).
//
// Strategy: only allow http(s); resolve the hostname to its IPs and reject any
// that fall in private/link-local/loopback/reserved ranges; follow redirects
// manually, re-validating each hop. This is not bulletproof against a
// determined DNS-rebinding attacker (the IP can change between our lookup and
// the runtime's connect), but it closes the practical importer SSRF vectors.

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

const MAX_REDIRECTS = 5;

function ipToParts(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return nums;
}

/** True if an IPv4/IPv6 address is private, loopback, link-local, or otherwise non-public. */
export function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);

  if (family === 4) {
    const p = ipToParts(ip);
    if (!p) return true; // unparseable → treat as unsafe
    const [a, b] = p;
    if (a === 0) return true; // 0.0.0.0/8 "this host"
    if (a === 10) return true; // 10.0.0.0/8 private
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (GCP/AWS metadata)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a === 192 && b === 0 && p[2] === 0) return true; // 192.0.0.0/24 IETF
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
    if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
    return false;
  }

  if (family === 6) {
    const norm = ip.toLowerCase().replace(/^\[|\]$/g, "");
    if (norm === "::1" || norm === "::") return true; // loopback / unspecified
    // IPv4-mapped (::ffff:a.b.c.d) — validate the embedded v4 address
    const mapped = norm.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedIp(mapped[1]);
    if (norm.startsWith("fc") || norm.startsWith("fd")) return true; // fc00::/7 unique-local
    if (norm.startsWith("fe8") || norm.startsWith("fe9") || norm.startsWith("fea") || norm.startsWith("feb")) {
      return true; // fe80::/10 link-local
    }
    return false;
  }

  return true; // not a valid IP literal → block
}

async function assertHostAllowed(urlStr: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    throw new SsrfError(`Invalid URL: ${urlStr}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfError(`Blocked URL scheme: ${url.protocol}`);
  }

  const host = url.hostname;

  // If the host is already an IP literal, check it directly.
  if (isIP(host)) {
    if (isBlockedIp(host)) throw new SsrfError(`Blocked private/reserved address: ${host}`);
    return;
  }

  // Resolve the hostname and reject if ANY resolved address is non-public.
  let records: { address: string }[];
  try {
    records = await lookup(host, { all: true });
  } catch {
    throw new SsrfError(`Could not resolve host: ${host}`);
  }
  if (records.length === 0) throw new SsrfError(`Host did not resolve: ${host}`);
  for (const { address } of records) {
    if (isBlockedIp(address)) {
      throw new SsrfError(`Host ${host} resolves to a blocked address (${address})`);
    }
  }
}

/**
 * Drop-in replacement for fetch() that validates the target (and every redirect
 * hop) against the SSRF blocklist before issuing the request. Throws SsrfError
 * for disallowed targets. Pass through the same init you'd give fetch(); the
 * `redirect` option is forced to "manual" internally so each hop can be checked.
 */
export async function safeFetch(input: string, init: RequestInit = {}): Promise<Response> {
  let currentUrl = input;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertHostAllowed(currentUrl);

    const res = await fetch(currentUrl, { ...init, redirect: "manual" });

    // Manual redirect handling so we can re-validate the next hop.
    if (res.status >= 300 && res.status < 400 && res.headers.has("location")) {
      const location = res.headers.get("location")!;
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    return res;
  }

  throw new SsrfError(`Too many redirects (>${MAX_REDIRECTS}) for ${input}`);
}
