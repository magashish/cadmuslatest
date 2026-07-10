// Single source of truth for the JWT signing secret used by auth tokens
// (middleware/auth.ts) and preview tokens (lib/preview.ts).
//
// SECURITY: never silently fall back to the dev secret in production. If
// JWT_SECRET is missing on a prod deploy, tokens would be signed/verified with
// a value committed to this repo — anyone could forge a cadmus_admin token and
// take over the platform. Fail fast at startup instead.
const DEV_FALLBACK = "cadmus-dev-secret-do-not-use-in-prod";

const configured = process.env.JWT_SECRET;

if (!configured && process.env.NODE_ENV === "production") {
  throw new Error(
    "JWT_SECRET environment variable is required in production. Refusing to start with the insecure dev fallback.",
  );
}

export const JWT_SECRET = configured || DEV_FALLBACK;
export const jwtSecretKey = new TextEncoder().encode(JWT_SECRET);
