import { SignJWT, jwtVerify } from "jose";
import { jwtSecretKey as secret } from "./jwt-secret.js";

// Short-lived, single-purpose token that lets the platform dashboard hand a
// cadmus_admin's session to the (different-origin) admin app for one site. The
// dashboard mints it (authenticated as cadmus_admin), puts it in the admin URL,
// and the admin app immediately exchanges it for a real session and strips it
// from the URL. The 120s TTL is the primary control; the exchange re-verifies
// the user is still cadmus_admin. (Future hardening: make it single-use.)
const HANDOFF_TTL = "120s";

interface HandoffPayload {
  userId: string;
  siteId: string;
}

export async function signHandoffToken(userId: string, siteId: string): Promise<string> {
  return new SignJWT({ userId, siteId, type: "handoff" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(HANDOFF_TTL)
    .sign(secret);
}

export async function verifyHandoffToken(token: string): Promise<HandoffPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    if (payload.type !== "handoff") return null;
    return { userId: payload.userId as string, siteId: payload.siteId as string };
  } catch {
    return null;
  }
}
