import { useState, useEffect, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "../context/AuthContext";
import { auth } from "../lib/api";

const RESEND_COOLDOWN_SECONDS = 60;

export function VerifyEmail() {
  const { t } = useTranslation();
  const { user, refreshUser } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");

  // Token verification state
  const [verifyState, setVerifyState] = useState<"idle" | "verifying" | "success" | "error">("idle");
  const [verifyError, setVerifyError] = useState("");
  const verifiedRef = useRef(false);

  // Resend state
  const [resending, setResending] = useState(false);
  const [resendSuccess, setResendSuccess] = useState(false);
  const [resendError, setResendError] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const cooldownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // The initial verification email is sent by POST /signup at account creation,
  // so we deliberately do NOT auto-send one here — doing so produced a duplicate
  // email on every signup (and React StrictMode double-fired it in dev). Users
  // who need another can use the "Resend" button below.

  // If token is in URL, verify it on mount
  useEffect(() => {
    if (!token || verifiedRef.current) return;
    verifiedRef.current = true;
    setVerifyState("verifying");
    auth
      .verifyEmail(token)
      .then(async () => {
        setVerifyState("success");
        // Refresh auth context so emailVerifiedAt is populated before navigating —
        // without this the route guard would redirect back to /verify-email.
        await refreshUser();
        setTimeout(() => navigate("/onboarding", { replace: true }), 2000);
      })
      .catch((err) => {
        setVerifyState("error");
        setVerifyError(err instanceof Error ? err.message : t("verifyEmail.error.generic"));
      });
  }, [token, navigate]);

  const startCooldown = () => {
    setCooldown(RESEND_COOLDOWN_SECONDS);
    if (cooldownRef.current) clearInterval(cooldownRef.current);
    cooldownRef.current = setInterval(() => {
      setCooldown((prev) => {
        if (prev <= 1) {
          if (cooldownRef.current) clearInterval(cooldownRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  useEffect(() => {
    return () => {
      if (cooldownRef.current) clearInterval(cooldownRef.current);
    };
  }, []);

  const handleResend = async () => {
    setResendError("");
    setResendSuccess(false);
    setResending(true);
    try {
      await auth.resendVerification();
      setResendSuccess(true);
      startCooldown();
    } catch (err) {
      setResendError(err instanceof Error ? err.message : t("verifyEmail.error.resendFailed"));
    } finally {
      setResending(false);
    }
  };

  // --- Token flow ---
  if (token) {
    if (verifyState === "verifying") {
      return (
        <div className="auth-page">
          <div className="auth-card">
            <h1>{t("sidebar.brand")}</h1>
            <p>{t("verifyEmail.verifying")}</p>
          </div>
        </div>
      );
    }

    if (verifyState === "success") {
      return (
        <div className="auth-page">
          <div className="auth-card">
            <h1>{t("sidebar.brand")}</h1>
            <h2>{t("verifyEmail.successTitle")}</h2>
            <p>{t("verifyEmail.successBody")}</p>
          </div>
        </div>
      );
    }

    if (verifyState === "error") {
      return (
        <div className="auth-page">
          <div className="auth-card">
            <h1>{t("sidebar.brand")}</h1>
            <h2>{t("verifyEmail.errorTitle")}</h2>
            <div className="auth-error">{verifyError}</div>
            {user && (
              <div style={{ marginTop: "1.5rem" }}>
                <p>{t("verifyEmail.needNewLink")}</p>
                {resendSuccess && <p className="auth-success">{t("verifyEmail.resendSuccess")}</p>}
                {resendError && <div className="auth-error">{resendError}</div>}
                <button
                  className="btn btn-primary btn-full"
                  onClick={handleResend}
                  disabled={resending || cooldown > 0}
                >
                  {resending ? t("verifyEmail.sending") : cooldown > 0 ? t("verifyEmail.resendCooldown", { seconds: cooldown }) : t("verifyEmail.resend")}
                </button>
              </div>
            )}
          </div>
        </div>
      );
    }
  }

  // --- Holding page (no token) ---
  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>{t("sidebar.brand")}</h1>
        <h2>{t("verifyEmail.checkInboxTitle")}</h2>
        <p>
          {t("verifyEmail.checkInboxBodyPrefix")}{" "}
          <strong>{user?.email ?? t("verifyEmail.yourEmailAddress")}</strong>{t("verifyEmail.checkInboxBodySuffix")}
        </p>
        <p style={{ color: "#666", fontSize: "0.875rem", marginTop: "0.5rem" }}>
          {t("verifyEmail.expiryNotice")}
        </p>
        {resendSuccess && (
          <p className="auth-success" style={{ marginTop: "1rem" }}>
            {t("verifyEmail.resendSuccess")}
          </p>
        )}
        {resendError && <div className="auth-error" style={{ marginTop: "1rem" }}>{resendError}</div>}
        <button
          className="btn btn-secondary btn-full"
          onClick={handleResend}
          disabled={resending || cooldown > 0}
          style={{ marginTop: "1.5rem" }}
        >
          {resending ? t("verifyEmail.sending") : cooldown > 0 ? t("verifyEmail.resendCooldown", { seconds: cooldown }) : t("verifyEmail.resend")}
        </button>
      </div>
    </div>
  );
}
