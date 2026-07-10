import { SignJWT, jwtVerify } from "jose";
import { jwtSecretKey as secret } from "./jwt-secret.js";

// Short-lived capability token for streaming a single staging media object
// through the API (GET /api/media-stream/:id?t=...). Lets a <video>/<img>/<a>
// tag — which can't send an Authorization header — fetch private staging bytes
// without a GCS signed URL (signBlob is unreliable on Cloud Run). Scoped to one
// media id, 15-minute TTL, signed with our own server secret.
export async function signMediaStreamToken(mediaId: string): Promise<string> {
  return new SignJWT({ mediaId, type: "media-stream" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(secret);
}

export async function verifyMediaStreamToken(token: string): Promise<{ mediaId: string } | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    if (payload.type !== "media-stream") return null;
    return { mediaId: payload.mediaId as string };
  } catch {
    return null;
  }
}
