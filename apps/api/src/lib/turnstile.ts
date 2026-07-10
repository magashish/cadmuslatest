// Cloudflare Turnstile server-side verification. Used by the
// "turnstile-spam-protection" add-on to validate the client-issued token on
// form submits. Fails closed on a bad/expired token, but the CALLER decides
// fail-open behavior when no secret is configured (a misconfigured platform
// must not break visitor forms).

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TIMEOUT_MS = 5000;

export interface TurnstileVerifyResult {
  success: boolean;
  errorCodes?: string[];
  /** Hostname the token was solved on (from siteverify). Callers use this to
   *  bind tokens to THIS site's hosts — pool/platform widgets are shared
   *  across tenants, so without this check a token solved on tenant A's
   *  domain would verify for tenant B's form. */
  hostname?: string;
}

export async function verifyTurnstileToken(
  token: string,
  secret: string,
  remoteIp?: string,
): Promise<TurnstileVerifyResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const form = new URLSearchParams();
    form.set("secret", secret);
    form.set("response", token);
    if (remoteIp) form.set("remoteip", remoteIp);

    const res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: controller.signal,
    });

    if (!res.ok) {
      return { success: false, errorCodes: [`http-${res.status}`] };
    }

    const data = (await res.json()) as {
      success?: boolean;
      "error-codes"?: string[];
      hostname?: string;
    };
    return {
      success: data.success === true,
      errorCodes: data["error-codes"],
      hostname: data.hostname,
    };
  } catch {
    // Network failure, timeout/abort, or malformed response.
    return { success: false, errorCodes: ["network-error"] };
  } finally {
    clearTimeout(timer);
  }
}
