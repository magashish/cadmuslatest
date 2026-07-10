import { pbkdf2Sync, randomBytes, timingSafeEqual } from "crypto";

// PBKDF2-HMAC-SHA512. OWASP's 2023 guidance for SHA-512 is ≥210k iterations.
const ITERATIONS = 210_000;
const KEYLEN = 64;
const DIGEST = "sha512";
const LEGACY_ITERATIONS = 100_000; // older hashes stored as "salt:hash"

export function meetsPasswordRequirements(password: string): boolean {
  return (
    password.length >= 12 &&
    /[A-Z]/.test(password) &&
    /[0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(password)
  );
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = pbkdf2Sync(password, salt, ITERATIONS, KEYLEN, DIGEST).toString("hex");
  // Tagged format records the iteration count so we can raise it later without
  // breaking existing hashes: pbkdf2$<iterations>$<salt>$<hash>
  return `pbkdf2$${ITERATIONS}$${salt}$${hash}`;
}

// Constant-time compare of two hex digests of equal length.
function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ba.length === 0 || ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function verifyPassword(password: string, stored: string): boolean {
  if (stored.startsWith("pbkdf2$")) {
    const [, iterStr, salt, hash] = stored.split("$");
    const iterations = Number(iterStr);
    if (!iterations || !salt || !hash) return false;
    const candidate = pbkdf2Sync(password, salt, iterations, KEYLEN, DIGEST).toString("hex");
    return safeEqualHex(candidate, hash);
  }
  // Legacy format: "salt:hash" at 100k iterations.
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = pbkdf2Sync(password, salt, LEGACY_ITERATIONS, KEYLEN, DIGEST).toString("hex");
  return safeEqualHex(candidate, hash);
}

// True if a stored hash uses an older format/iteration count and should be
// re-hashed (transparently, on next successful login).
export function passwordNeedsRehash(stored: string): boolean {
  if (!stored.startsWith("pbkdf2$")) return true;
  const iterations = Number(stored.split("$")[1]);
  return !iterations || iterations < ITERATIONS;
}

// Burns roughly one PBKDF2's worth of CPU without revealing anything. Used on
// the login "no such user" path so response timing doesn't distinguish a
// registered email from an unregistered one.
export function dummyVerify(password: string): void {
  pbkdf2Sync(password, "0".repeat(32), ITERATIONS, KEYLEN, DIGEST);
}
