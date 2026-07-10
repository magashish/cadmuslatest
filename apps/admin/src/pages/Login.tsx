import { useState, type FormEvent } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "../context/AuthContext";

export function Login() {
  const { t } = useTranslation();
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const locationState = location.state as { message?: string; returnTo?: string } | null;
  const successMessage = locationState?.message;
  const returnTo = locationState?.returnTo;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      // Honor ?siteId=X in the URL (from dashboard "Open Admin") so the server
      // can run its status gate against the intended site, not the user's default.
      const requestedSiteId = new URLSearchParams(window.location.search).get("siteId") || undefined;
      await login(email, password, requestedSiteId);
      navigate(returnTo ?? "/");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("login.error"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>{t("sidebar.brand")}</h1>
        <h2>{t("login.title")}</h2>
        {successMessage && <div style={{ color: "#16a34a", background: "#f0fdf4", padding: "0.75rem", borderRadius: "6px", marginBottom: "1rem", fontSize: "0.9rem" }}>{successMessage}</div>}
        {error && <div className="auth-error">{error}</div>}
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>{t("common.emailLabel")}</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="form-group">
            <label>{t("common.passwordLabel")}</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <button type="submit" className="btn btn-primary btn-full" disabled={submitting}>
            {submitting ? t("login.signingIn") : t("login.signIn")}
          </button>
        </form>
        <p className="auth-link">
          <Link to="/forgot-password">{t("login.forgotPassword")}</Link>
        </p>
        <p className="auth-link">
          {t("login.noAccount")} <Link to="/signup">{t("login.signUp")}</Link>
        </p>
      </div>
    </div>
  );
}
