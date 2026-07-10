import crypto from "node:crypto";

// One-way hash for single-use tokens (password reset, email verification, team
// invites). The raw token is only ever sent to the user (by email); we store the
// hash so a read-only DB leak can't be turned into a usable link. Lookups hash
// the submitted token and compare.
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
