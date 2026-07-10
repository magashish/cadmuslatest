import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "../context/AuthContext";

export function ProtectedRoute() {
  const { t } = useTranslation();
  const { user, siteStatus, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="auth-page">
        <p>{t("common.loading")}</p>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" state={{ returnTo: location.pathname + location.search }} replace />;
  }

  // Block access to the admin if email is not yet verified
  if (!user.emailVerifiedAt) {
    return <Navigate to="/verify-email" replace />;
  }

  // Partner accounts with no site land on the partner portal — the site-scoped
  // admin has nothing to show them.
  const isPartnerWithoutSite = user.globalRole === "partner" && !user.siteId;
  if (isPartnerWithoutSite && location.pathname !== "/partner") {
    return <Navigate to="/partner" replace />;
  }
  if (location.pathname === "/partner" && user.globalRole !== "partner") {
    return <Navigate to="/" replace />;
  }

  if (siteStatus === "onboarding") {
    return <Navigate to="/onboarding" replace />;
  }

  return <Outlet />;
}
