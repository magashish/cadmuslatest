import { SignJWT, jwtVerify } from "jose";
import { jwtSecretKey as secret } from "./jwt-secret.js";

interface PreviewPayload {
  contentId: string;
  siteId: string;
}

export async function signPreviewToken(contentId: string, siteId: string): Promise<string> {
  return new SignJWT({ contentId, siteId, type: "preview" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("24h")
    .sign(secret);
}

export async function verifyPreviewToken(token: string): Promise<PreviewPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    if (payload.type !== "preview") return null;
    return {
      contentId: payload.contentId as string,
      siteId: payload.siteId as string,
    };
  } catch {
    return null;
  }
}
