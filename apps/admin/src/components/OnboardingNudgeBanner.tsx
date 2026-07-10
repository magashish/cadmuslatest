import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "../context/AuthContext";
import { site } from "../lib/api";

export function OnboardingNudgeBanner() {
  const { t } = useTranslation();
  const { user, skippedOnboarding, clearSkippedOnboarding, refreshSiteStatus } = useAuth();
  const navigate = useNavigate();
  const [starting, setStarting] = useState(false);

  if (!skippedOnboarding) return null;

  const handleSetUp = async () => {
    if (!user || starting) return;
    setStarting(true);
    try {
      await site.restartOnboarding(user.siteId);
      await refreshSiteStatus();
      // refreshSiteStatus sets siteStatus to "onboarding", which causes
      // ProtectedRoute to redirect to /onboarding automatically.
      // The explicit navigate is a fallback.
      navigate("/onboarding");
    } catch {
      setStarting(false);
    }
  };

  const handleDismiss = () => {
    clearSkippedOnboarding();
  };

  return (
    <div
      style={{
        padding: "0.625rem 1rem",
        marginBottom: "0.75rem",
        background: "#eff6ff",
        borderBottom: "1px solid #bfdbfe",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        fontSize: "0.875rem",
        color: "#1e40af",
      }}
    >
      <span>{t("onboardingBanner.message")}</span>
      <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
        <button
          type="button"
          onClick={handleSetUp}
          disabled={starting}
          style={{
            padding: "0.25rem 0.75rem",
            background: "#2563eb",
            color: "#fff",
            border: "none",
            borderRadius: "4px",
            cursor: starting ? "default" : "pointer",
            fontSize: "0.8125rem",
            fontWeight: 600,
            whiteSpace: "nowrap",
            opacity: starting ? 0.7 : 1,
          }}
        >
          {starting ? t("onboardingBanner.starting") : t("onboardingBanner.setUp")}
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "#1e40af",
            fontSize: "1rem",
            lineHeight: 1,
            padding: "0 0.25rem",
          }}
          aria-label={t("onboardingBanner.dismiss")}
        >
          ×
        </button>
      </div>
    </div>
  );
}
