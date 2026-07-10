import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { auth, site, setSiteId, isAbortError, ApiError } from "../lib/api";
import i18n, { isSupportedLocale } from "../i18n";


interface SiteMembership {
  siteId: string;
  siteName: string;
  subdomain: string;
  domain: string | null;
  domainStatus: string | null;
  role: string;
  status: string;
}

interface User {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  role: string;
  siteId: string;
  globalRole?: string;
  memberships?: SiteMembership[];
  emailVerifiedAt?: string | null;
  locale?: string;
}

interface AuthContextValue {
  user: User | null;
  siteStatus: string | null;
  sitePlan: string | null;
  suspensionReason: string | null;
  archiveReason: string | null;
  hardDeleteAt: string | null;
  skippedOnboarding: boolean;
  loading: boolean;
  login: (email: string, password: string, siteId?: string) => Promise<void>;
  signup: (email: string, password: string, siteId: string) => Promise<void>;
  provision: (name: string, email: string, password: string, promoCode?: string, referralCode?: string, clientCode?: string) => Promise<{ promoApplied?: boolean }>;
  logout: () => void;
  refreshSiteStatus: () => Promise<void>;
  refreshUser: () => Promise<void>;
  switchSite: (siteId: string) => Promise<void>;
  clearSkippedOnboarding: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [siteStatus, setSiteStatus] = useState<string | null>(null);
  const [sitePlan, setSitePlan] = useState<string | null>(null);
  const [suspensionReason, setSuspensionReason] = useState<string | null>(null);
  const [archiveReason, setArchiveReason] = useState<string | null>(null);
  const [hardDeleteAt, setHardDeleteAt] = useState<string | null>(null);
  const [skippedOnboarding, setSkippedOnboarding] = useState(false);
  const [loading, setLoading] = useState(true);

  // Apply the user's saved language preference once it's known. Until then
  // (or for guests/no preference) the browser/localStorage default from
  // src/i18n applies.
  useEffect(() => {
    const locale = user?.locale;
    if (isSupportedLocale(locale) && i18n.language !== locale) {
      void i18n.changeLanguage(locale);
    }
  }, [user?.locale]);

  const fetchSiteStatus = useCallback(async (siteId: string) => {
    // Partner-portal sessions have no site context — nothing to fetch.
    if (!siteId) {
      setSiteStatus(null);
      setSitePlan(null);
      setSuspensionReason(null);
      setArchiveReason(null);
      setHardDeleteAt(null);
      setSkippedOnboarding(false);
      return;
    }
    try {
      const s = await site.get(siteId);
      setSiteStatus(s.status);
      setSitePlan((s.plan as string | null | undefined) ?? null);
      setSuspensionReason((s.suspensionReason as string | null | undefined) ?? null);
      setArchiveReason((s.archiveReason as string | null | undefined) ?? null);
      setHardDeleteAt((s.hardDeleteAt as string | null | undefined) ?? null);
      const settings = (s.settings as Record<string, unknown> | null | undefined) ?? {};
      setSkippedOnboarding(settings.skippedOnboarding === true);
    } catch {
      setSiteStatus(null);
      setSitePlan(null);
      setSuspensionReason(null);
      setArchiveReason(null);
      setHardDeleteAt(null);
      setSkippedOnboarding(false);
    }
  }, []);

  const refreshSiteStatus = useCallback(async () => {
    if (user) {
      await fetchSiteStatus(user.siteId);
    }
  }, [user, fetchSiteStatus]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    const init = async () => {
      // A ?handoff= token (from the platform dashboard's "Open Admin") carries a
      // cadmus_admin session across origins. Exchange it for a real session
      // first, then strip it from the URL so it isn't left in history.
      const params = new URLSearchParams(window.location.search);
      const handoffToken = params.get("handoff");
      if (handoffToken) {
        params.delete("handoff");
        const newSearch = params.toString();
        window.history.replaceState({}, "", window.location.pathname + (newSearch ? "?" + newSearch : "") + window.location.hash);
        try {
          const res = await auth.handoff(handoffToken);
          if (cancelled) return;
          localStorage.setItem("ap_token", res.token);
          setSiteId(res.user.siteId);
          setUser(res.user);
          await fetchSiteStatus(res.user.siteId);
          return;
        } catch {
          // Fall through to any existing session below.
        }
      }

      const token = localStorage.getItem("ap_token");
      if (!token) return;
      try {
        const res = await auth.me(controller.signal);
        if (cancelled) return;
        if (res.token) localStorage.setItem("ap_token", res.token);
        setSiteId(res.user.siteId);
        setUser(res.user);
        await fetchSiteStatus(res.user.siteId);
      } catch (err) {
        // A navigation/unmount abort or a transient network blip is not an auth
        // failure — keep the token so the user isn't silently logged out.
        // Only clear it when the server actually rejects the session (401).
        if (isAbortError(err) || cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          localStorage.removeItem("ap_token");
        }
      }
    };

    init().finally(() => {
      if (!cancelled) setLoading(false);
    });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [fetchSiteStatus]);

  const loginFn = async (email: string, password: string, siteId?: string) => {
    const res = await auth.login(email, password, siteId);
    localStorage.setItem("ap_token", res.token);
    setSiteId(res.user.siteId);
    setUser(res.user);
    await fetchSiteStatus(res.user.siteId);
  };

  const signupFn = async (email: string, password: string, siteId: string) => {
    const res = await auth.signup(email, password, siteId);
    localStorage.setItem("ap_token", res.token);
    setSiteId(res.user.siteId);
    setUser(res.user);
    await fetchSiteStatus(res.user.siteId);
  };

  const provisionFn = async (name: string, email: string, password: string, promoCode?: string, referralCode?: string, clientCode?: string) => {
    const res = await auth.signup(email, password, name, promoCode, referralCode, clientCode);
    localStorage.setItem("ap_token", res.token);
    setSiteId(res.user.siteId);
    setUser(res.user);
    setSiteStatus("onboarding");
    setSitePlan("free");
    setSuspensionReason(null);
    setArchiveReason(null);
    setHardDeleteAt(null);
    return { promoApplied: res.promoApplied };
  };

  const switchSiteFn = useCallback(async (targetSiteId: string) => {
    const res = await auth.switchSite(targetSiteId);
    localStorage.setItem("ap_token", res.token);
    setSiteId(res.user.siteId);
    setUser(res.user);
    await fetchSiteStatus(res.user.siteId);
  }, [fetchSiteStatus]);

  // Honor ?siteId= in the URL (from dashboard "Open Admin") — auto-switch and clean up.
  const urlSiteIdHandled = useRef(false);
  useEffect(() => {
    if (!user || urlSiteIdHandled.current) return;
    urlSiteIdHandled.current = true;

    const params = new URLSearchParams(window.location.search);
    const targetSiteId = params.get("siteId");
    if (!targetSiteId) return;

    params.delete("siteId");
    const newSearch = params.toString();
    const newUrl = window.location.pathname + (newSearch ? "?" + newSearch : "") + window.location.hash;
    window.history.replaceState({}, "", newUrl);

    if (targetSiteId !== user.siteId) {
      switchSiteFn(targetSiteId).catch(() => {});
    }
  }, [user, switchSiteFn]);

  const refreshUser = useCallback(async () => {
    const token = localStorage.getItem("ap_token");
    if (!token) return;
    const res = await auth.me();
    if (res.token) localStorage.setItem("ap_token", res.token);
    setSiteId(res.user.siteId);
    setUser(res.user);
  }, []);

  const clearSkippedOnboarding = useCallback(async () => {
    if (!user) return;
    setSkippedOnboarding(false);
    await site.update(user.siteId, { settings: { skippedOnboarding: false } });
  }, [user]);

  const logout = () => {
    localStorage.removeItem("ap_token");
    setSiteId(null);
    setUser(null);
    setSiteStatus(null);
    setSitePlan(null);
    setSuspensionReason(null);
    setArchiveReason(null);
    setHardDeleteAt(null);
    setSkippedOnboarding(false);
  };

  return (
    <AuthContext.Provider
      value={{ user, siteStatus, sitePlan, suspensionReason, archiveReason, hardDeleteAt, skippedOnboarding, loading, login: loginFn, signup: signupFn, provision: provisionFn, logout, refreshSiteStatus, refreshUser, switchSite: switchSiteFn, clearSkippedOnboarding }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
