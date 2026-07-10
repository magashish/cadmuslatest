import { eq, and } from "drizzle-orm";
import { db, siteAddons, addons } from "@cadmus/db";
import { logError } from "./log.js";

// Auto-provisions Cloudflare Turnstile for custom-domain sites.
//
// The platform widget's hostname allowlist covers cadmus.digital (+ all
// subdomains) only — a site on its own domain fails Turnstile's hostname
// validation. Rather than making owners bring their own keys, we maintain a
// pool of platform-managed widgets ("cadmus-custom-domains-N") and add each
// active custom domain to a widget with free capacity, storing the resulting
// sitekey/secret on the site's add-on config.
//
// Free-plan limits (see todo.txt): 20 widgets/account x 10 hostnames/widget
// ≈ ~190 custom-domain slots. At scale, move to Turnstile Enterprise "Any
// Hostname" and delete this pool.
//
// Config keys written here (provisionedSitekey/provisionedSecretKey/
// provisionedDomain) are deliberately NOT in the registry's allowedConfigKeys:
// tenants can't read or overwrite them (pool secrets are shared across up to
// 10 tenants), and user BYO keys always take precedence.

const POOL_NAME_PREFIX = "cadmus-custom-domains-";
const MAX_HOSTNAMES_PER_WIDGET = 10; // Turnstile free-plan limit
const TURNSTILE_SLUG = "turnstile-spam-protection";
const CF_API = "https://api.cloudflare.com/client/v4";

interface CfWidget {
  sitekey: string;
  secret?: string;
  name: string;
  domains: string[];
  mode: string;
}

function getCfConfig(): { accountId: string; token: string } | null {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const token = process.env.CLOUDFLARE_TURNSTILE_API_TOKEN?.trim();
  if (!accountId || !token) return null;
  return { accountId, token };
}

export function isTurnstileProvisioningConfigured(): boolean {
  return getCfConfig() !== null;
}

async function cfFetch<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const cfg = getCfConfig();
  if (!cfg) throw new Error("Turnstile provisioning is not configured");
  const res = await fetch(`${CF_API}/accounts/${cfg.accountId}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json",
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const data = (await res.json()) as { success: boolean; result: T; errors?: { message: string }[] };
  if (!data.success) {
    throw new Error(`Turnstile API error: ${data.errors?.map((e) => e.message).join("; ") || res.status}`);
  }
  return data.result;
}

// Widget hostname entries cover their subdomains, so registering the apex
// covers www.<domain> (and any other subdomain) too.
function apexOf(domain: string): string {
  return domain.replace(/^www\./i, "").toLowerCase();
}

async function loadTurnstileInstall(siteId: string) {
  const [row] = await db
    .select({ id: siteAddons.id, status: siteAddons.status, config: siteAddons.config })
    .from(siteAddons)
    .innerJoin(addons, eq(siteAddons.addonId, addons.id))
    .where(and(eq(siteAddons.siteId, siteId), eq(addons.slug, TURNSTILE_SLUG)));
  return row ?? null;
}

/**
 * Ensure a custom-domain site has working Turnstile keys. No-op when:
 * provisioning isn't configured, the add-on isn't actively installed, the
 * site brought its own keys, or a pool widget already covers it.
 * Best-effort by design — callers must not let a failure here block the
 * install or the domain-activation flow.
 */
export async function ensureTurnstileProvisioned(siteId: string, domain: string): Promise<void> {
  if (!isTurnstileProvisioningConfigured()) return;

  const install = await loadTurnstileInstall(siteId);
  if (!install || install.status !== "active") return;

  const config = (install.config as Record<string, unknown>) ?? {};
  if (typeof config.sitekey === "string" && config.sitekey.trim()) return; // user BYO wins
  const apex = apexOf(domain);
  if (config.provisionedSitekey && config.provisionedDomain === apex) return; // already done

  // Find a pool widget with capacity, or create the next one.
  const widgets = await cfFetch<CfWidget[]>(`/challenges/widgets?per_page=50`);
  const pool = widgets.filter((w) => w.name.startsWith(POOL_NAME_PREFIX));
  let target = pool.find((w) => w.domains.length < MAX_HOSTNAMES_PER_WIDGET);

  let sitekey: string;
  let secret: string;
  if (target) {
    // The list response omits the secret — fetch the widget, then append the
    // domain (PUT replaces the full domains array).
    const detail = await cfFetch<CfWidget>(`/challenges/widgets/${target.sitekey}`);
    const domains = Array.from(new Set([...detail.domains, apex]));
    const updated = await cfFetch<CfWidget>(`/challenges/widgets/${target.sitekey}`, {
      method: "PUT",
      body: { name: detail.name, mode: detail.mode, domains },
    });
    sitekey = updated.sitekey;
    secret = updated.secret ?? detail.secret ?? "";
  } else {
    const created = await cfFetch<CfWidget>(`/challenges/widgets`, {
      method: "POST",
      body: { name: `${POOL_NAME_PREFIX}${pool.length + 1}`, mode: "managed", domains: [apex] },
    });
    sitekey = created.sitekey;
    secret = created.secret ?? "";
  }
  if (!sitekey || !secret) throw new Error("Turnstile API returned no sitekey/secret");

  await db
    .update(siteAddons)
    .set({
      config: { ...config, provisionedSitekey: sitekey, provisionedSecretKey: secret, provisionedDomain: apex },
      updatedAt: new Date(),
    })
    .where(eq(siteAddons.id, install.id));

  console.log(`[turnstile-provision] provisioned ${apex} for site ${siteId} on widget ${sitekey}`);
}

/**
 * Reclaim the pool hostname slot when a site disconnects its custom domain.
 * Removes the domain from its pool widget (deleting the widget if it would be
 * left empty) and clears the provisioned keys. Best-effort.
 */
export async function deprovisionTurnstileForDomain(siteId: string): Promise<void> {
  const install = await loadTurnstileInstall(siteId);
  if (!install) return;
  const config = (install.config as Record<string, unknown>) ?? {};
  const sitekey = config.provisionedSitekey as string | undefined;
  const provisionedDomain = config.provisionedDomain as string | undefined;

  const {
    provisionedSitekey: _sk,
    provisionedSecretKey: _sec,
    provisionedDomain: _dom,
    ...rest
  } = config;

  if (sitekey && provisionedDomain && isTurnstileProvisioningConfigured()) {
    try {
      const detail = await cfFetch<CfWidget>(`/challenges/widgets/${sitekey}`);
      const domains = detail.domains.filter((d) => d !== provisionedDomain);
      if (domains.length === 0) {
        await cfFetch(`/challenges/widgets/${sitekey}`, { method: "DELETE" });
      } else {
        await cfFetch(`/challenges/widgets/${sitekey}`, {
          method: "PUT",
          body: { name: detail.name, mode: detail.mode, domains },
        });
      }
    } catch (err) {
      // Slot reclamation is hygiene, not correctness — log and still clear
      // the local keys so the site falls back cleanly.
      logError(`[turnstile-provision] failed to reclaim slot for site ${siteId}`, err);
    }
  }

  await db
    .update(siteAddons)
    .set({ config: rest, updatedAt: new Date() })
    .where(eq(siteAddons.id, install.id));
}
