// Add-on registry — an enumerable, in-code map of the first-party ("builtin")
// add-ons. This is the seed of the future sandbox manifest: each entry declares
// which config keys a site may set (`allowedConfigKeys`) and how that config is
// projected into the PUBLIC site payload (`publicConfig`) so secrets never leak
// to visitors.
//
// Unknown slugs (e.g. a catalog row added ahead of its registry entry) fall back
// to a locked-down default: no writable config keys, empty public config.

export interface AddonPublicConfigContext {
  /** True when the site is served on an active custom domain (not
   *  *.cadmus.digital). Keys scoped to platform hostnames don't work there. */
  hasActiveCustomDomain?: boolean;
}

export interface AddonRegistryEntry {
  slug: string;
  allowedConfigKeys: string[];
  // Project a site's stored config into the subset that's safe to serve to
  // public visitors. Must NEVER return secret material.
  publicConfig(config: Record<string, unknown>, ctx?: AddonPublicConfigContext): Record<string, unknown>;
}

const REGISTRY: Record<string, AddonRegistryEntry> = {
  "turnstile-spam-protection": {
    slug: "turnstile-spam-protection",
    // BYO keys: a site can override the platform's shared Turnstile keys.
    // (provisionedSitekey/provisionedSecretKey/provisionedDomain are written
    // server-side by turnstile-provision.ts and deliberately NOT allowed here —
    // pool secrets are shared across tenants and must stay invisible.)
    allowedConfigKeys: ["sitekey", "secretKey"],
    publicConfig(config, ctx) {
      // Only the sitekey is public; secrets stay server-side. Precedence:
      // user BYO key → auto-provisioned pool key → platform key. The platform
      // key's widget only allows *.cadmus.digital, so on an active custom
      // domain with no per-site key we return null (no widget, and the server
      // skips enforcement) rather than a key that would fail hostname
      // validation and block the site's forms.
      // .trim(): a stray trailing newline in the GCP secret would corrupt the
      // rendered widget sitekey (same failure mode as the CF token headers).
      const perSite =
        (config.sitekey as string | undefined)?.trim() ||
        (config.provisionedSitekey as string | undefined)?.trim();
      if (perSite) return { sitekey: perSite };
      if (ctx?.hasActiveCustomDomain) return { sitekey: null };
      return { sitekey: process.env.TURNSTILE_SITE_KEY?.trim() || null };
    },
  },
  "mortgage-calculator": {
    slug: "mortgage-calculator",
    allowedConfigKeys: [],
    publicConfig() {
      return {};
    },
  },
  "form-file-uploads": {
    slug: "form-file-uploads",
    // No site-configurable settings in v1 — limits (count, size, extension
    // allowlist) are platform constants in lib/form-uploads.ts. Entitlement
    // alone unlocks the "file" field type in the form editor and multipart
    // submissions on the public API.
    allowedConfigKeys: [],
    publicConfig() {
      return {};
    },
  },
  "visitor-chatbot": {
    slug: "visitor-chatbot",
    // `instructions` is server-only guidance for the bot and is intentionally
    // NOT surfaced in publicConfig.
    allowedConfigKeys: ["instructions", "greeting", "enabled"],
    publicConfig(config) {
      return {
        greeting: (config.greeting as string | undefined) || null,
        enabled: config.enabled !== false,
      };
    },
  },
};

const DEFAULT_ENTRY: Omit<AddonRegistryEntry, "slug"> = {
  allowedConfigKeys: [],
  publicConfig() {
    return {};
  },
};

export function getAddonRegistryEntry(slug: string): AddonRegistryEntry {
  const entry = REGISTRY[slug];
  if (entry) return entry;
  return { slug, ...DEFAULT_ENTRY };
}
