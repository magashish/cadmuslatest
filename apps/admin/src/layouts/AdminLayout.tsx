import { useState, useEffect, useCallback } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "../context/AuthContext";
import { AIDrawer } from "../components/AIDrawer";
import { AIDrawerButton } from "../components/AIDrawerButton";
import { TrialBanner } from "../components/TrialBanner";
import { PastDueBanner } from "../components/PastDueBanner";
import { SuspensionBanner } from "../components/SuspensionBanner";
import { OnboardingNudgeBanner } from "../components/OnboardingNudgeBanner";
import { ai, type Insight } from "../lib/api";

const navItems: { to: string; labelKey: string; minRole?: string; indexableOnly?: boolean }[] = [
  { to: "/", labelKey: "nav.dashboard" },
  { to: "/insights", labelKey: "nav.insights" },
  { to: "/content", labelKey: "nav.content" },
  { to: "/collections", labelKey: "nav.collections" },
  { to: "/forms", labelKey: "nav.forms", minRole: "admin" },
  { to: "/media", labelKey: "nav.media" },
  { to: "/theme", labelKey: "nav.style", minRole: "admin" },
  { to: "/seo", labelKey: "nav.seo", minRole: "admin", indexableOnly: true },
  { to: "/addons", labelKey: "nav.addons", minRole: "admin" },
  { to: "/redirects", labelKey: "nav.redirects", minRole: "admin" },
  { to: "/activity", labelKey: "nav.activity", minRole: "admin" },
  { to: "/team", labelKey: "nav.team" },
  { to: "/account", labelKey: "nav.account" },
  { to: "/settings", labelKey: "nav.settings", minRole: "admin" },
  { to: "/help", labelKey: "nav.help" },
];

const ROLE_LEVEL: Record<string, number> = { viewer: 1, editor: 2, admin: 3, owner: 4 };

interface Message {
  role: "user" | "assistant";
  content: string;
  path?: string;
  turnId?: string;
  turnDecision?: "accepted" | "rejected";
  turnDecisionError?: string;
  actions?: { type: string; status: "success" | "error"; result?: Record<string, unknown>; error?: string; historyId?: string }[];
}

const initialMessages: Message[] = [
  {
    role: "assistant",
    content:
      "Hi! I'm your Cadmus AI assistant. I can help you create content, improve your site's SEO, optimize for conversions, and more. What would you like to work on?",
  },
];

function dismissStorageKey(siteId: string) {
  return `cadmus:dismissed-insights:${siteId}`;
}

function loadDismissed(siteId: string): Set<string> {
  try {
    const raw = localStorage.getItem(dismissStorageKey(siteId));
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as string[];
    return new Set(arr);
  } catch {
    return new Set();
  }
}

function saveDismissed(siteId: string, ids: Set<string>) {
  try {
    localStorage.setItem(dismissStorageKey(siteId), JSON.stringify(Array.from(ids)));
  } catch {
    // ignore quota / privacy-mode errors
  }
}

export function AdminLayout() {
  const { t } = useTranslation();
  const { user, sitePlan, logout, switchSite } = useAuth();
  const location = useLocation();
  const [aiOpen, setAiOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [switching, setSwitching] = useState(false);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(() =>
    user?.siteId ? loadDismissed(user.siteId) : new Set(),
  );

  const siteId = user?.siteId;

  useEffect(() => {
    if (siteId) setDismissed(loadDismissed(siteId));
  }, [siteId]);

  useEffect(() => {
    const handler = () => setAiOpen(true);
    window.addEventListener("cadmus:open-ai-drawer", handler);
    return () => window.removeEventListener("cadmus:open-ai-drawer", handler);
  }, []);

  useEffect(() => {
    if (!siteId) {
      setInsights([]);
      return;
    }
    let cancelled = false;
    ai.insights()
      .then((res) => {
        if (!cancelled) setInsights(res.insights);
      })
      .catch(() => {
        if (!cancelled) setInsights([]);
      });
    return () => {
      cancelled = true;
    };
  }, [siteId, location.pathname]);

  const handleDismissInsight = useCallback(
    (id: string) => {
      if (!siteId) return;
      setDismissed((prev) => {
        const next = new Set(prev);
        next.add(id);
        saveDismissed(siteId, next);
        return next;
      });
    },
    [siteId],
  );

  const visibleInsights = insights.filter((i) => !dismissed.has(i.id));
  const pathname = location.pathname;
  const pageVisibleInsights = visibleInsights.filter(
    (i) => !i.page || pathname === i.page || pathname.startsWith(`${i.page}/`),
  );

  const memberships = user?.memberships?.filter((m) => m.status === "active") || [];
  const hasMultipleSites = memberships.length > 1;
  const currentSite = memberships.find((m) => m.siteId === user?.siteId);

  const baseDomain = (import.meta.env.VITE_BASE_DOMAIN as string | undefined) || "cadmus.digital";
  const siteUrl = currentSite
    ? currentSite.domain && (currentSite.domainStatus === "active" || currentSite.domain === baseDomain)
      ? `https://${currentSite.domain}`
      : baseDomain === "cadmus.digital"
        ? `https://${currentSite.subdomain}.cadmus.digital`
        : `https://${currentSite.subdomain}--dev.cadmus.digital`
    : null;

  const handleSiteSwitch = async (siteId: string) => {
    if (siteId === user?.siteId || switching) return;
    setSwitching(true);
    try {
      await switchSite(siteId);
      window.location.href = "/admin";
    } catch {
      setSwitching(false);
    }
  };

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeOnNav = () => setSidebarOpen(false);

  return (
    <div className={`admin-layout${sidebarOpen ? " sidebar-open" : ""}`}>
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Mobile top bar */}
      <div className="mobile-topbar">
        <button
          className="hamburger"
          onClick={() => setSidebarOpen((o) => !o)}
          aria-label={t("sidebar.toggleMenu")}
        >
          <span /><span /><span />
        </button>
        <span className="mobile-topbar__title">{t("sidebar.brand")}</span>
      </div>

      <aside className="sidebar">
        <div className="sidebar-header">
          <h1>{t("sidebar.brand")}</h1>
          {hasMultipleSites && (
            <select
              className="site-switcher"
              value={user?.siteId || ""}
              onChange={(e) => handleSiteSwitch(e.target.value)}
              disabled={switching}
            >
              {memberships.map((m) => (
                <option key={m.siteId} value={m.siteId}>
                  {m.siteName || m.subdomain}
                </option>
              ))}
            </select>
          )}
          {siteUrl && (
            <a
              className="view-site-link"
              href={siteUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("sidebar.viewSite")}
            </a>
          )}
        </div>
        <nav>
          {navItems
            .filter((item) => {
              // Free-tier sites are noindex — hide SEO-only tools.
              if (item.indexableOnly && sitePlan === "free") return false;
              if (!item.minRole) return true;
              const userLevel = ROLE_LEVEL[user?.role || "viewer"] || 1;
              const minLevel = ROLE_LEVEL[item.minRole] || 1;
              return userLevel >= minLevel;
            })
            .map((item) => {
              const showBadge =
                item.to === "/insights" && visibleInsights.length > 0;
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === "/"}
                  className={({ isActive }) =>
                    `nav-link ${isActive ? "active" : ""}`
                  }
                  onClick={closeOnNav}
                >
                  <span className="nav-link__label">{t(item.labelKey)}</span>
                  {showBadge && (
                    <span
                      className="nav-link__badge"
                      aria-label={t("sidebar.insightsBadge", { count: visibleInsights.length })}
                    >
                      {visibleInsights.length > 9 ? "9+" : visibleInsights.length}
                    </span>
                  )}
                </NavLink>
              );
            })}
        </nav>
        <div className="sidebar-footer">
          <span className="sidebar-user-email">{user?.email}</span>
          <button type="button" className="btn-sidebar-logout" onClick={logout}>
            {t("sidebar.logout")}
          </button>
        </div>
      </aside>
      <main className="main-content">
        <OnboardingNudgeBanner />
        <SuspensionBanner />
        <TrialBanner />
        <PastDueBanner />
        <Outlet />
      </main>
      {(ROLE_LEVEL[user?.role || "viewer"] || 1) >= ROLE_LEVEL.editor && (
        <AIDrawerButton onClick={() => setAiOpen(true)} badgeCount={pageVisibleInsights.length} />
      )}
      <AIDrawer
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        messages={messages}
        setMessages={setMessages}
        currentPath={location.pathname}
        insights={pageVisibleInsights}
        onDismissInsight={handleDismissInsight}
      />
    </div>
  );
}
