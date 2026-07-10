// URL builders that respect the dev cert constraint.
//
// Dev uses single-level subdomains ({subdomain}--dev.cadmus.digital) to stay
// under the *.cadmus.digital wildcard cert — NOT {subdomain}.dev.cadmus.digital
// which would need its own wildcard.
//
// Admin SPA is served from canonical hostnames only:
//   prod: cadmus.digital/admin
//   dev:  dev.cadmus.digital/admin

export function getBaseDomain(): string {
  return process.env.BASE_DOMAIN || "cadmus.digital";
}

export function getSiteHost(subdomain: string, baseDomain = getBaseDomain()): string {
  return baseDomain === "cadmus.digital"
    ? `${subdomain}.cadmus.digital`
    : `${subdomain}--dev.cadmus.digital`;
}

export function getSiteUrl(subdomain: string, baseDomain = getBaseDomain()): string {
  return `https://${getSiteHost(subdomain, baseDomain)}`;
}

export function getAdminUrl(baseDomain = getBaseDomain()): string {
  return `https://${baseDomain}/admin`;
}
