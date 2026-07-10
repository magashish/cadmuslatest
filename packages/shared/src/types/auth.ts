export type SiteRole = "owner" | "admin" | "editor" | "viewer";
export type GlobalRole = "user" | "partner" | "cadmus_admin";

// Admin dashboard UI language. Keep in sync with apps/admin/src/i18n/locales/*.
export const SUPPORTED_LOCALES = ["en", "hi"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export interface SiteMembership {
  siteId: string;
  siteName: string;
  subdomain: string;
  domain: string | null;
  domainStatus: string | null;
  role: SiteRole;
  status: string;
}

export interface AuthUser {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  role: string; // current site role (from site_members)
  siteId: string; // current site context
  globalRole?: GlobalRole;
  memberships?: SiteMembership[]; // all sites this user belongs to
  emailVerifiedAt?: Date | string | null; // null until email is verified
  tokenVersion?: number; // bumped to revoke all of this user's existing JWTs
  locale?: Locale; // admin dashboard UI language, from users.preferences.locale
}

export interface LoginRequest {
  email: string;
  password: string;
  siteId?: string; // optional — pick specific site, otherwise use default
}

export interface SignupRequest {
  email: string;
  password: string;
  siteId: string;
}

export interface AuthResponse {
  token: string;
  user: AuthUser;
}
