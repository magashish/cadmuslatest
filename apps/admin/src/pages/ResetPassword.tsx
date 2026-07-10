import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { PasswordStrengthMeter, meetsPasswordRequirements } from "../components/PasswordStrengthMeter";

const API_BASE = import.meta.env.VITE_API_URL || "";

export function ResetPassword() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  if (!token) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1>{t("sidebar.brand")}</h1>
          <h2>{t("resetPassword.invalidTitle")}</h2>
          <p style={{ color: "#666", lineHeight: 1.6, marginBottom: "1.5rem" }}>
            {t("resetPassword.invalidBody")}
          </p>
          <Link to="/forgot-password" className="btn btn-primary btn-full" style={{ display: "block", textAlign: "center", textDecoration: "none" }}>
            {t("resetPassword.requestNewLink")}
          </Link>
        </div>
      </div>
    );
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");

    if (password !== confirm) {
      setError(t("resetPassword.error.mismatch"));
      return;
    }

    if (!meetsPasswordRequirements(password)) {
      setError(t("resetPassword.error.requirements"));
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword: password }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || t("resetPassword.error.generic"));
      }
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("resetPassword.error.generic"));
    } finally {
      setSubmitting(false);
    }
  };

  if (success) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1>{t("sidebar.brand")}</h1>
          <h2>{t("resetPassword.successTitle")}</h2>
          <p style={{ color: "#666", lineHeight: 1.6, marginBottom: "1.5rem" }}>
            {t("resetPassword.successBody")}
          </p>
          <Link to="/login" className="btn btn-primary btn-full" style={{ display: "block", textAlign: "center", textDecoration: "none" }}>
            {t("resetPassword.signIn")}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>{t("sidebar.brand")}</h1>
        <h2>{t("resetPassword.title")}</h2>
        {error && <div className="auth-error">{error}</div>}
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>{t("resetPassword.newPasswordLabel")}</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoFocus
              minLength={12}
              placeholder={t("resetPassword.passwordPlaceholder")}
            />
            <PasswordStrengthMeter password={password} />
          </div>
          <div className="form-group">
            <label>{t("resetPassword.confirmLabel")}</label>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              minLength={12}
            />
          </div>
          <button type="submit" className="btn btn-primary btn-full" disabled={submitting}>
            {submitting ? t("resetPassword.submitting") : t("resetPassword.submit")}
          </button>
        </form>
      </div>
    </div>
  );
}
