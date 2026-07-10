import { useState, useEffect } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { PasswordStrengthMeter, meetsPasswordRequirements } from "../components/PasswordStrengthMeter";

const API = import.meta.env.VITE_API_URL || "";

export function AcceptInvite() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get("token") || "";

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [validating, setValidating] = useState(true);
  const [error, setError] = useState("");
  const [invalidMessage, setInvalidMessage] = useState("");
  const [hasPassword, setHasPassword] = useState(false);
  const [email, setEmail] = useState("");

  // Validate token on page load
  useEffect(() => {
    if (!token) {
      setInvalidMessage(t("acceptInvite.invalidMissing"));
      setValidating(false);
      return;
    }

    fetch(`${API}/api/team/validate-invite?token=${encodeURIComponent(token)}`)
      .then((res) => res.json())
      .then((data) => {
        if (!data.valid) {
          setInvalidMessage(data.error || t("acceptInvite.invalidExpired"));
        } else {
          setHasPassword(data.hasPassword);
          setEmail(data.email || "");
        }
      })
      .catch(() => {
        setInvalidMessage(t("acceptInvite.error.loadFailed"));
      })
      .finally(() => setValidating(false));
  }, [token]);

  const handleAccept = async (skipPassword: boolean) => {
    if (!skipPassword) {
      if (!meetsPasswordRequirements(password)) {
        setError(t("acceptInvite.error.requirements"));
        return;
      }
      if (password !== confirmPassword) {
        setError(t("acceptInvite.error.mismatch"));
        return;
      }
    }

    setLoading(true);
    setError("");

    try {
      const res = await fetch(`${API}/api/team/accept-invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password: skipPassword ? undefined : password }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || t("acceptInvite.error.acceptFailed"));
        return;
      }

      navigate("/login", { state: { message: t("acceptInvite.acceptedRedirectMessage") } });
    } catch {
      setError(t("acceptInvite.error.generic"));
    } finally {
      setLoading(false);
    }
  };

  if (validating) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h2>{t("acceptInvite.checkingTitle")}</h2>
        </div>
      </div>
    );
  }

  if (invalidMessage) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h2>{t("acceptInvite.unavailableTitle")}</h2>
          <p style={{ color: "#666", marginBottom: "1.5rem" }}>{invalidMessage}</p>
          <button
            className="btn btn-primary"
            onClick={() => navigate("/login")}
            style={{ width: "100%" }}
          >
            {t("acceptInvite.goToLogin")}
          </button>
        </div>
      </div>
    );
  }

  // User already has a password — just accept directly
  if (hasPassword) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h2>{t("acceptInvite.title")}</h2>
          <p style={{ color: "#666", marginBottom: "1.5rem" }}>
            {t("acceptInvite.joiningAsPrefix")} <strong>{email}</strong>{t("acceptInvite.joiningAsSuffix")}
          </p>

          {error && <p className="auth-error">{error}</p>}

          <button
            className="btn btn-primary"
            onClick={() => handleAccept(true)}
            disabled={loading}
            style={{ width: "100%", marginTop: "0.5rem" }}
          >
            {loading ? t("acceptInvite.accepting") : t("acceptInvite.acceptInvitation")}
          </button>
        </div>
      </div>
    );
  }

  // New user — needs to set a password
  return (
    <div className="auth-page">
      <div className="auth-card">
        <h2>{t("acceptInvite.title")}</h2>
        <p style={{ color: "#666", marginBottom: "1.5rem" }}>
          {t("acceptInvite.setPasswordBody", { suffix: email ? ` for ${email}` : "" })}
        </p>

        {error && <p className="auth-error">{error}</p>}

        <div className="form-group">
          <label>{t("common.passwordLabel")}</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t("acceptInvite.passwordPlaceholder")}
            onKeyDown={(e) => e.key === "Enter" && handleAccept(false)}
          />
          <PasswordStrengthMeter password={password} />
        </div>

        <div className="form-group">
          <label>{t("acceptInvite.confirmPasswordLabel")}</label>
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder={t("acceptInvite.confirmPasswordPlaceholder")}
            onKeyDown={(e) => e.key === "Enter" && handleAccept(false)}
          />
        </div>

        <button
          className="btn btn-primary"
          onClick={() => handleAccept(false)}
          disabled={loading}
          style={{ width: "100%", marginTop: "0.5rem" }}
        >
          {loading ? t("acceptInvite.accepting") : t("acceptInvite.acceptAndSetPassword")}
        </button>
      </div>
    </div>
  );
}
