import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

const API_BASE = import.meta.env.VITE_API_URL || "";

export function ForgotPassword() {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || t("forgotPassword.error.generic"));
      }
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("forgotPassword.error.generic"));
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1>{t("sidebar.brand")}</h1>
          <h2>{t("forgotPassword.checkEmailTitle")}</h2>
          <p style={{ color: "#666", lineHeight: 1.6, marginBottom: "1.5rem" }}>
            {t("forgotPassword.checkEmailBodyPrefix")} <strong>{email}</strong>{t("forgotPassword.checkEmailBodySuffix")}
          </p>
          <Link to="/login" className="btn btn-primary btn-full" style={{ display: "block", textAlign: "center", textDecoration: "none" }}>
            {t("forgotPassword.backToSignIn")}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>{t("sidebar.brand")}</h1>
        <h2>{t("forgotPassword.title")}</h2>
        <p style={{ color: "#666", lineHeight: 1.6, marginBottom: "1.5rem" }}>
          {t("forgotPassword.description")}
        </p>
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
          <button type="submit" className="btn btn-primary btn-full" disabled={submitting}>
            {submitting ? t("forgotPassword.sending") : t("forgotPassword.submit")}
          </button>
        </form>
        <p className="auth-link">
          <Link to="/login">{t("forgotPassword.backToSignIn")}</Link>
        </p>
      </div>
    </div>
  );
}
