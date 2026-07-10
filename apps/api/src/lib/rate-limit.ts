// Simple in-memory rate limiter. Fine for a single Cloud Run instance; if we
// ever horizontally scale the API we'll need a shared store (Redis / Firestore).

interface RateLimitBucket {
  max: number;
  windowMs: number;
  store: Map<string, { count: number; resetAt: number }>;
}

const buckets = new Map<string, RateLimitBucket>();

// Periodic cleanup of expired entries across all buckets
setInterval(() => {
  const now = Date.now();
  for (const bucket of buckets.values()) {
    for (const [key, val] of bucket.store) {
      if (val.resetAt < now) bucket.store.delete(key);
    }
  }
}, 300_000);

export function createRateLimiter(name: string, max: number, windowMs: number) {
  const bucket: RateLimitBucket = { max, windowMs, store: new Map() };
  buckets.set(name, bucket);

  return {
    // Returns true if the request is allowed, false if the limit is exceeded.
    check(key: string): boolean {
      const now = Date.now();
      const entry = bucket.store.get(key);
      if (!entry || entry.resetAt < now) {
        bucket.store.set(key, { count: 1, resetAt: now + windowMs });
        return true;
      }
      entry.count++;
      return entry.count <= max;
    },
    // Clear a key — call on successful auth so legitimate users don't get
    // locked out after a few typos.
    reset(key: string): void {
      bucket.store.delete(key);
    },
  };
}

// Number of trusted proxies that append to X-Forwarded-For in front of the app.
// On Cloud Run (managed) the Google front end appends the real client IP as the
// LAST entry, so the default of 1 selects it. If an external HTTPS load balancer
// is added in front (one more hop), set TRUSTED_PROXY_COUNT=2.
const TRUSTED_PROXY_COUNT = Math.max(1, Number(process.env.TRUSTED_PROXY_COUNT ?? "1") || 1);

// Derives the client IP for rate-limit keying. X-Forwarded-For is built left to
// right, so the LEFT entries are client-supplied and spoofable; the trusted
// infrastructure appends real values on the RIGHT. We therefore pick the entry
// `TRUSTED_PROXY_COUNT` positions from the right (the hop our infra observed),
// which an attacker can't forge — preventing both limit evasion and poisoning a
// victim's bucket by spoofing their IP.
export function getClientIp(headers: {
  "x-forwarded-for"?: string | null;
  "x-real-ip"?: string | null;
}): string {
  const fwd = headers["x-forwarded-for"];
  if (fwd) {
    const ips = fwd.split(",").map((s) => s.trim()).filter(Boolean);
    if (ips.length > 0) {
      const idx = Math.max(0, ips.length - TRUSTED_PROXY_COUNT);
      return ips[idx];
    }
  }
  return headers["x-real-ip"]?.trim() || "unknown";
}
