import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../context/AuthContext";
import { auth, billing, team, media, type BillingPlanDetails, type BillingStatus, type TeamMember } from "../lib/api";
import { PasswordStrengthMeter, meetsPasswordRequirements } from "../components/PasswordStrengthMeter";
import i18n, { SUPPORTED_LOCALES, isSupportedLocale, type SupportedLocale } from "../i18n";

export function Account() {
  const { t } = useTranslation();
  const { user, refreshUser } = useAuth();
  const [firstName, setFirstName] = useState(user?.firstName || "");
  const [lastName, setLastName] = useState(user?.lastName || "");
  const [profileSaved, setProfileSaved] = useState(false);
  const [profileError, setProfileError] = useState("");
  const [profileSaving, setProfileSaving] = useState(false);

  const userLocale = user?.locale;
  const [language, setLanguage] = useState<SupportedLocale>(
    isSupportedLocale(userLocale) ? userLocale : (i18n.language as SupportedLocale),
  );
  const [languageSaved, setLanguageSaved] = useState(false);
  const [languageError, setLanguageError] = useState("");
  const [languageSaving, setLanguageSaving] = useState(false);

  const handleLanguageSave = async () => {
    setLanguageError("");
    setLanguageSaved(false);
    setLanguageSaving(true);
    try {
      await auth.updateProfile({ locale: language });
      await i18n.changeLanguage(language);
      await refreshUser();
      setLanguageSaved(true);
      setTimeout(() => setLanguageSaved(false), 3000);
    } catch (e) {
      setLanguageError(e instanceof Error ? e.message : t("account.language.error"));
    } finally {
      setLanguageSaving(false);
    }
  };

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordSaved, setPasswordSaved] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const [passwordSaving, setPasswordSaving] = useState(false);

  const handleProfileSave = async () => {
    setProfileError("");
    setProfileSaved(false);
    setProfileSaving(true);
    try {
      await auth.updateProfile({ firstName, lastName });
      setProfileSaved(true);
      setTimeout(() => setProfileSaved(false), 3000);
    } catch (e) {
      setProfileError(e instanceof Error ? e.message : t("account.profile.errors.saveFailed"));
    } finally {
      setProfileSaving(false);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <h2>{t("account.title")}</h2>
      </div>

      <section className="settings-section">
        <h3>{t("account.profile.title")}</h3>
        <div className="settings-form">
          <label>
            {t("account.profile.email")}
            <input type="email" value={user?.email || ""} disabled />
          </label>
          <div style={{ display: "flex", gap: "1rem" }}>
            <label style={{ flex: 1 }}>
              {t("account.profile.firstName")}
              <input
                type="text"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                placeholder={t("account.profile.firstNamePlaceholder")}
              />
            </label>
            <label style={{ flex: 1 }}>
              {t("account.profile.lastName")}
              <input
                type="text"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                placeholder={t("account.profile.lastNamePlaceholder")}
              />
            </label>
          </div>
          <div className="settings-actions">
            <button
              className="btn btn-primary"
              disabled={profileSaving}
              onClick={handleProfileSave}
            >
              {profileSaving ? t("account.profile.saving") : t("account.profile.save")}
            </button>
            {profileSaved && <span className="settings-success">{t("account.profile.saved")}</span>}
            {profileError && <span className="auth-error">{profileError}</span>}
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h3>{t("account.language.title")}</h3>
        <div className="settings-form">
          <label>
            {t("account.language.label")}
            <select value={language} onChange={(e) => setLanguage(e.target.value as SupportedLocale)}>
              {SUPPORTED_LOCALES.map((code) => (
                <option key={code} value={code}>
                  {t(`languages.${code}`)}
                </option>
              ))}
            </select>
          </label>
          <p style={{ color: "var(--color-text-muted)", fontSize: "0.9rem", margin: 0 }}>
            {t("account.language.hint")}
          </p>
          <div className="settings-actions">
            <button
              className="btn btn-primary"
              disabled={languageSaving}
              onClick={handleLanguageSave}
            >
              {languageSaving ? t("account.language.saving") : t("account.language.save")}
            </button>
            {languageSaved && <span className="settings-success">{t("account.language.saved")}</span>}
            {languageError && <span className="auth-error">{languageError}</span>}
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h3>{t("account.password.title")}</h3>
        <div className="settings-form">
          <label>
            {t("account.password.current")}
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </label>
          <label>
            {t("account.password.new")}
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder={t("account.password.newPlaceholder")}
            />
            <PasswordStrengthMeter password={newPassword} />
          </label>
          <label>
            {t("account.password.confirm")}
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </label>
          <div className="settings-actions">
            <button
              className="btn btn-primary"
              disabled={passwordSaving || !currentPassword || !newPassword || !confirmPassword}
              onClick={async () => {
                setPasswordError("");
                setPasswordSaved(false);
                if (newPassword !== confirmPassword) {
                  setPasswordError(t("account.password.errors.mismatch"));
                  return;
                }
                if (!meetsPasswordRequirements(newPassword)) {
                  setPasswordError(t("account.password.errors.requirements"));
                  return;
                }
                setPasswordSaving(true);
                try {
                  const res = await auth.changePassword(currentPassword, newPassword);
                  // Persist the re-issued token so this session survives the
                  // tokenVersion bump that logs out all other sessions.
                  if (res.token) localStorage.setItem("ap_token", res.token);
                  setPasswordSaved(true);
                  setCurrentPassword("");
                  setNewPassword("");
                  setConfirmPassword("");
                  setTimeout(() => setPasswordSaved(false), 3000);
                } catch (e) {
                  setPasswordError(e instanceof Error ? e.message : t("account.password.errors.changeFailed"));
                } finally {
                  setPasswordSaving(false);
                }
              }}
            >
              {passwordSaving ? t("account.profile.saving") : t("account.password.change")}
            </button>
            {passwordSaved && <span className="settings-success">{t("account.password.saved")}</span>}
            {passwordError && <span className="auth-error">{passwordError}</span>}
          </div>
        </div>
      </section>

      <StorageSection />

      <BillingSection />
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let val = bytes / 1024;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(val >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function StorageSection() {
  const { t } = useTranslation();
  const [usage, setUsage] = useState<{ usedBytes: number; quotaBytes: number; fileCount: number; uploadLimitBytes: number } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    media.usage()
      .then(setUsage)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const pct = usage && usage.quotaBytes > 0
    ? Math.min(100, Math.round((usage.usedBytes / usage.quotaBytes) * 100))
    : 0;
  const near = pct >= 80;
  const barColor = pct >= 95 ? "#dc2626" : near ? "#f59e0b" : "var(--color-primary, #2563eb)";

  return (
    <section className="settings-section">
      <h3>{t("account.storage.title")}</h3>
      {loading ? (
        <p style={{ color: "var(--color-text-muted)" }}>{t("common.loading")}</p>
      ) : !usage ? (
        <p style={{ color: "var(--color-text-muted)" }}>{t("account.storage.unavailable")}</p>
      ) : (
        <div className="settings-form">
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.9rem", marginBottom: "0.4rem" }}>
            <span style={{ fontWeight: 600 }}>
              {t("account.storage.usedOf", { used: formatBytes(usage.usedBytes), quota: formatBytes(usage.quotaBytes) })}
            </span>
            <span style={{ color: "var(--color-text-muted)" }}>{pct}%</span>
          </div>
          <div style={{ height: 8, borderRadius: 999, background: "var(--color-surface-2, #eee)", overflow: "hidden" }}>
            <div style={{ width: `${pct}%`, height: "100%", background: barColor, transition: "width 0.3s" }} />
          </div>
          <p style={{ fontSize: "0.85rem", color: "var(--color-text-muted)", margin: "0.5rem 0 0" }}>
            {t("account.storage.fileCount", { count: usage.fileCount, limit: formatBytes(usage.uploadLimitBytes) })}
            {near && <span style={{ color: barColor, fontWeight: 600 }}> {t("account.storage.lowSpace")}</span>}
          </p>
        </div>
      )}
    </section>
  );
}

function BillingSection() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [data, setData] = useState<BillingStatus | null>(null);
  const [plans, setPlans] = useState<BillingPlanDetails[]>([]);
  const [loading, setLoading] = useState(true);
  const [activating, setActivating] = useState(false);
  const [actionLoading, setActionLoading] = useState("");
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);
  const [confirmPlanSwitch, setConfirmPlanSwitch] = useState<"monthly" | "annual" | null>(null);
  const [planError, setPlanError] = useState("");
  const [selectedUpgradePlan, setSelectedUpgradePlan] = useState<"monthly" | "annual">("monthly");

  const isOwnerOrAdmin = user?.role === "owner" || user?.role === "admin";
  const isOwner = user?.role === "owner";

  const reloadStatus = () => billing.status().then(setData).catch(() => {});

  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      const params = new URLSearchParams(window.location.search);
      const justCheckedOut = params.get("billing") === "success";

      // Strip the ?billing= flag so a refresh doesn't re-trigger the poll.
      if (params.has("billing")) {
        params.delete("billing");
        const search = params.toString();
        window.history.replaceState({}, "", window.location.pathname + (search ? "?" + search : "") + window.location.hash);
      }

      let status = await billing.status().catch(() => null);
      if (cancelled) return;
      if (status) setData(status);
      setLoading(false);

      // Returning from Stripe Checkout, but the plan still reads Free? The
      // checkout.session.completed webhook hasn't landed yet. Poll briefly so
      // we don't strand the user on a stale "Free" view (bug: upgrade showed
      // Free until manual refresh).
      if (justCheckedOut && status?.billing === "free") {
        setActivating(true);
        for (let i = 0; i < 10 && !cancelled; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          if (cancelled) return;
          status = await billing.status().catch(() => null);
          if (cancelled) return;
          if (status) {
            setData(status);
            if (status.billing !== "free") break;
          }
        }
        if (!cancelled) setActivating(false);
      }
    };

    init();
    billing.plans().then((r) => setPlans(r.plans)).catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  const handleAddPayment = async (plan?: "monthly" | "annual") => {
    setActionLoading("checkout");
    try {
      const { url } = await billing.createCheckoutSession(window.location.href, plan);
      window.location.href = url;
    } catch (e) {
      alert(e instanceof Error ? e.message : t("account.billing.errors.checkoutFailed"));
    } finally {
      setActionLoading("");
    }
  };

  if (loading) {
    return (
      <section className="settings-section">
        <h3>{t("account.billing.title")}</h3>
        <p>{t("account.billing.loading")}</p>
      </section>
    );
  }

  if (activating) {
    return (
      <section className="settings-section">
        <h3>{t("account.billing.title")}</h3>
        <p>{t("account.billing.activating")}</p>
      </section>
    );
  }

  // Comped / internal sites are billing-free but fully unlocked — show the
  // "staff override" state, not the free-plan upgrade prompt. Checked before the
  // billing === "free" branch since a comped site is also billing-free.
  if (data?.comped) {
    const isCompedPlan = data.plan === "comped";
    const planLabel = data.plan === "annual" ? "Annual" : data.plan === "monthly" ? "Monthly" : "Comped";
    return (
      <section className="settings-section">
        <h3>{t("account.billing.title")}</h3>
        <div className="settings-form">
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.75rem" }}>
            <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: "#16a34a" }} />
            <span style={{ fontWeight: 600 }}>{isCompedPlan ? t("account.billing.compedAllUnlocked") : t("account.billing.planSuffix", { plan: planLabel })}</span>
            <span style={{ fontSize: "0.75rem", fontWeight: 600, color: "#2563eb", background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 999, padding: "0.1rem 0.5rem" }}>
              {t("account.billing.staffOverride")}
            </span>
          </div>
          <p style={{ color: "var(--color-text-muted)", lineHeight: 1.5 }}>
            {isCompedPlan
              ? t("account.billing.compedBodyAll")
              : t("account.billing.compedBodyPlan", { plan: planLabel.toLowerCase() })}
          </p>
        </div>
      </section>
    );
  }

  if (data?.billing === "free") {
    return (
      <section className="settings-section">
        <h3>{t("account.billing.title")}</h3>
        <div className="settings-form">
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.75rem" }}>
            <span
              style={{
                display: "inline-block",
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "#16a34a",
              }}
            />
            <span style={{ fontWeight: 600 }}>{t("account.billing.freePlan")}</span>
          </div>
          <p style={{ color: "var(--color-text-muted)", marginBottom: "1rem", lineHeight: 1.5 }}>
            {t("account.billing.freeBody")}
          </p>
          {isOwnerOrAdmin && plans.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              <div style={{ display: "flex", gap: "0.75rem" }}>
                {plans.map((p) => (
                  <button
                    key={p.plan}
                    type="button"
                    onClick={() => setSelectedUpgradePlan(p.plan)}
                    style={{
                      flex: 1,
                      padding: "0.75rem",
                      border: `2px solid ${selectedUpgradePlan === p.plan ? "var(--color-primary)" : "var(--color-border)"}`,
                      borderRadius: "6px",
                      background: selectedUpgradePlan === p.plan ? "var(--color-primary-subtle, #f0f9ff)" : "transparent",
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    <div style={{ fontWeight: 600, textTransform: "capitalize" }}>{p.plan}</div>
                    <div style={{ fontSize: "0.85rem", color: "var(--color-text-muted)" }}>{p.label}</div>
                  </button>
                ))}
              </div>
              <button
                className="btn btn-primary"
                disabled={!!actionLoading}
                onClick={() => handleAddPayment(selectedUpgradePlan)}
              >
                {actionLoading === "checkout" ? t("account.billing.redirectingCheckout") : t("account.billing.upgradeTo", { plan: selectedUpgradePlan })}
              </button>
            </div>
          )}
          {isOwnerOrAdmin && plans.length === 0 && (
            <button
              className="btn btn-primary"
              disabled={!!actionLoading}
              onClick={() => handleAddPayment("monthly")}
            >
              {actionLoading === "checkout" ? t("account.billing.redirecting") : t("account.billing.upgradePlan")}
            </button>
          )}
        </div>
      </section>
    );
  }


  if (!data?.subscription) {
    return (
      <section className="settings-section">
        <h3>{t("account.billing.title")}</h3>
        <div className="settings-form">
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.75rem" }}>
            <span
              style={{
                display: "inline-block",
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "#2563eb",
              }}
            />
            <span style={{ fontWeight: 600 }}>{t("account.billing.freePlan")}</span>
          </div>
          <p style={{ color: "var(--color-text-muted)", marginBottom: "1rem", lineHeight: 1.5 }}>
            {t("account.billing.freeBody")}
          </p>
          {isOwnerOrAdmin && (
            <button
              className="btn btn-primary"
              disabled={!!actionLoading}
              onClick={() => handleAddPayment("monthly")}
            >
              {actionLoading === "checkout" ? t("account.billing.redirecting") : t("account.billing.upgradePlan")}
            </button>
          )}
        </div>
      </section>
    );
  }

  const sub = data.subscription;

  const statusLabel: Record<string, string> = {
    trialing: t("account.billing.freePlan"),
    active: t("account.billing.statusActive"),
    past_due: t("account.billing.statusPastDue"),
    canceled: t("account.billing.statusCanceled"),
    unpaid: t("account.billing.statusUnpaid"),
    paused: t("account.billing.statusPaused"),
  };

  const statusColor: Record<string, string> = {
    trialing: "#2563eb",
    active: "#16a34a",
    past_due: "#dc2626",
    canceled: "#6b7280",
    unpaid: "#dc2626",
    paused: "#f59e0b",
  };

  const daysLeft = sub.trialEndsAt
    ? Math.max(0, Math.ceil((new Date(sub.trialEndsAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
    : null;

  const handleManageBilling = async () => {
    setActionLoading("portal");
    try {
      const { url } = await billing.createPortalSession(window.location.href);
      window.location.href = url;
    } catch (e) {
      alert(e instanceof Error ? e.message : t("account.billing.errors.portalFailed"));
    } finally {
      setActionLoading("");
    }
  };

  const handleCancel = async () => {
    setActionLoading("cancel");
    try {
      await billing.cancel();
      setData((prev) =>
        prev
          ? { ...prev, subscription: prev.subscription ? { ...prev.subscription, cancelAtPeriodEnd: true } : null }
          : null
      );
      setConfirmCancel(false);
    } catch (e) {
      alert(e instanceof Error ? e.message : t("account.billing.errors.cancelFailed"));
    } finally {
      setActionLoading("");
    }
  };

  const handleChangePlan = async (newPlan: "monthly" | "annual") => {
    setActionLoading("plan");
    setPlanError("");
    try {
      await billing.changePlan(newPlan);
      await reloadStatus();
      setConfirmPlanSwitch(null);
    } catch (e) {
      setPlanError(e instanceof Error ? e.message : t("account.billing.errors.planChangeFailed"));
    } finally {
      setActionLoading("");
    }
  };

  const handleReactivate = async () => {
    setActionLoading("reactivate");
    try {
      await billing.reactivate();
      setData((prev) =>
        prev
          ? { ...prev, subscription: prev.subscription ? { ...prev.subscription, cancelAtPeriodEnd: false } : null }
          : null
      );
    } catch (e) {
      alert(e instanceof Error ? e.message : t("account.billing.errors.reactivateFailed"));
    } finally {
      setActionLoading("");
    }
  };

  return (
    <section className="settings-section">
      <h3>{t("account.billing.title")}</h3>
      <div className="settings-form">
        <div style={{ display: "flex", gap: "2rem", flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: "0.8125rem", color: "#6b7280", marginBottom: "0.25rem" }}>{t("account.billing.planStatus")}</div>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <span
                style={{
                  display: "inline-block",
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: statusColor[sub.status] || "#6b7280",
                }}
              />
              <span style={{ fontWeight: 600 }}>{statusLabel[sub.status] || sub.status}</span>
              {sub.status === "trialing" && daysLeft !== null && (
                <span style={{ color: "#6b7280", fontSize: "0.8125rem" }}>
                  {t("account.billing.daysRemaining", { count: daysLeft })}
                </span>
              )}
              {sub.cancelAtPeriodEnd && (
                <span style={{ color: "#dc2626", fontSize: "0.8125rem" }}>
                  {t("account.billing.cancelsAtEnd")}
                </span>
              )}
            </div>
          </div>

          {sub.plan && (
            <div>
              <div style={{ fontSize: "0.8125rem", color: "#6b7280", marginBottom: "0.25rem" }}>{t("account.billing.plan")}</div>
              <div style={{ fontWeight: 600 }}>
                {(() => {
                  const current = plans.find((p) => p.plan === sub.plan);
                  if (!current) return sub.plan === "annual" ? t("account.billing.planAnnual") : t("account.billing.planMonthly");
                  const price = current.interval === "year" ? `$${current.amountUsd}/yr` : `$${current.amountUsd}/mo`;
                  return `${current.label} (${price})`;
                })()}
              </div>
            </div>
          )}

          {sub.currentPeriodEnd && (
            <div>
              <div style={{ fontSize: "0.8125rem", color: "#6b7280", marginBottom: "0.25rem" }}>
                {sub.status === "trialing" ? t("account.billing.trialEnds") : t("account.billing.periodEnds")}
              </div>
              <div style={{ fontWeight: 600 }}>
                {new Date(sub.status === "trialing" && sub.trialEndsAt ? sub.trialEndsAt : sub.currentPeriodEnd).toLocaleDateString()}
              </div>
            </div>
          )}

          <div>
            <div style={{ fontSize: "0.8125rem", color: "#6b7280", marginBottom: "0.25rem" }}>{t("account.billing.paymentMethod")}</div>
            <div style={{ fontWeight: 600 }}>
              {data.paymentMethod
                ? `${t("account.billing.cardEndingIn", {
                    brand: (data.paymentMethod.brand || "Card").charAt(0).toUpperCase() + (data.paymentMethod.brand || "card").slice(1),
                    last4: data.paymentMethod.last4,
                  })}${
                    data.paymentMethod.expiryMonth && data.paymentMethod.expiryYear
                      ? ` (${String(data.paymentMethod.expiryMonth).padStart(2, "0")}/${data.paymentMethod.expiryYear})`
                      : ""
                  }`
                : t("account.billing.noPaymentMethod")}
            </div>
          </div>

          {data.billingUser && (
            <div>
              <div style={{ fontSize: "0.8125rem", color: "#6b7280", marginBottom: "0.25rem" }}>{t("account.billing.billedTo")}</div>
              <div style={{ fontWeight: 600 }}>
                {data.billingUser.name}
                {data.billingPartner && (
                  <span style={{ marginLeft: "0.5rem", fontSize: "0.75rem", padding: "0.1rem 0.4rem", borderRadius: "4px", background: "#ede9fe", color: "#6d28d9" }}>
                    {t("account.billing.partnerLabel", { name: data.billingPartner.name })}
                  </span>
                )}
              </div>
              <div style={{ fontSize: "0.8125rem", color: "#6b7280" }}>{data.billingUser.email}</div>
            </div>
          )}
        </div>

        {data.addons && data.addons.length > 0 && (
          <div style={{ marginTop: "1.25rem" }}>
            <div style={{ fontSize: "0.8125rem", color: "#6b7280", marginBottom: "0.4rem" }}>{t("account.billing.addons")}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
              {data.addons.map((a) => (
                <div key={a.slug} style={{ fontSize: "0.9rem" }}>
                  <span style={{ fontWeight: 600 }}>{a.name}</span>
                  <span style={{ color: "#6b7280" }}>
                    {" — "}${(a.priceCents / 100) % 1 === 0 ? a.priceCents / 100 : (a.priceCents / 100).toFixed(2)}
                    {a.interval === "year" ? "/yr" : "/mo"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {isOwnerOrAdmin && (
          <div className="settings-actions" style={{ marginTop: "1rem" }}>
            {!data.hasPaymentMethod && (
              <button
                className="btn btn-primary"
                disabled={!!actionLoading}
                onClick={() => handleAddPayment()}
              >
                {actionLoading === "checkout" ? t("account.billing.redirecting") : t("account.billing.addPaymentMethod")}
              </button>
            )}

            {data.hasPaymentMethod && (
              <button
                className="btn btn-primary"
                disabled={!!actionLoading}
                onClick={handleManageBilling}
              >
                {actionLoading === "portal" ? t("account.billing.redirecting") : t("account.billing.manageBilling")}
              </button>
            )}

            {sub.plan && plans.length > 1 && sub.status !== "canceled" && !sub.cancelAtPeriodEnd && (
              (() => {
                const otherPlan: "monthly" | "annual" = sub.plan === "annual" ? "monthly" : "annual";
                const otherDetails = plans.find((p) => p.plan === otherPlan);
                if (!otherDetails) return null;
                return (
                  <button
                    className="btn"
                    disabled={!!actionLoading}
                    onClick={() => {
                      setPlanError("");
                      setConfirmPlanSwitch(otherPlan);
                    }}
                  >
                    {t("account.billing.switchTo", { plan: otherDetails.label })}
                  </button>
                );
              })()
            )}

            {user?.role === "owner" && sub.status !== "canceled" && !sub.cancelAtPeriodEnd && (
              <button
                className="btn"
                style={{ color: "#dc2626" }}
                disabled={!!actionLoading}
                onClick={() => setConfirmCancel(true)}
              >
                {t("account.billing.cancelSubscription")}
              </button>
            )}

            {user?.role === "owner" && sub.cancelAtPeriodEnd && (
              <button
                className="btn btn-primary"
                disabled={!!actionLoading}
                onClick={handleReactivate}
              >
                {actionLoading === "reactivate" ? t("account.billing.reactivating") : t("account.billing.reactivateSubscription")}
              </button>
            )}

            {isOwner && (
              <button
                className="btn"
                disabled={!!actionLoading}
                onClick={() => setShowTransfer(true)}
              >
                {t("account.billing.transferBilling")}
              </button>
            )}
          </div>
        )}
      </div>

      {showTransfer && (
        <TransferBillingModal
          currentBillingUserId={data.subscription?.billingUserId ?? null}
          onClose={() => setShowTransfer(false)}
          onSuccess={async () => {
            setShowTransfer(false);
            await reloadStatus();
          }}
        />
      )}

      {confirmPlanSwitch && (() => {
        const targetDetails = plans.find((p) => p.plan === confirmPlanSwitch);
        if (!targetDetails || !sub.plan) return null;
        return (
          <PlanSwitchModal
            targetPlan={confirmPlanSwitch}
            targetDetails={targetDetails}
            submitting={actionLoading === "plan"}
            error={planError}
            onClose={() => {
              setConfirmPlanSwitch(null);
              setPlanError("");
            }}
            onConfirm={() => handleChangePlan(confirmPlanSwitch)}
          />
        );
      })()}

      {confirmCancel && (
        <CancelSubscriptionModal
          periodEnd={sub.currentPeriodEnd}
          isTrialing={sub.status === "trialing"}
          submitting={actionLoading === "cancel"}
          onClose={() => setConfirmCancel(false)}
          onConfirm={handleCancel}
        />
      )}
    </section>
  );
}

function TransferBillingModal({
  currentBillingUserId,
  onClose,
  onSuccess,
}: {
  currentBillingUserId: string | null;
  onClose: () => void;
  onSuccess: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"user" | "partner">("user");
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(true);
  const [targetUserId, setTargetUserId] = useState("");
  const [partnerCode, setPartnerCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    team.list()
      .then((r) => {
        const active = r.members.filter((m) => m.status === "active" && m.userId !== currentBillingUserId);
        setMembers(active);
      })
      .catch(() => {})
      .finally(() => setLoadingMembers(false));
  }, [currentBillingUserId]);

  const handleSubmit = async () => {
    setError("");
    if (mode === "user" && !targetUserId) {
      setError(t("account.billing.transferModal.errors.chooseMember"));
      return;
    }
    if (mode === "partner" && !partnerCode.trim()) {
      setError(t("account.billing.transferModal.errors.enterCode"));
      return;
    }
    setSubmitting(true);
    try {
      await billing.transfer(
        mode === "user" ? { targetUserId } : { partnerCode: partnerCode.trim() }
      );
      await onSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("account.billing.transferModal.errors.transferFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "#fff", borderRadius: "8px", padding: "1.5rem",
          width: "90%", maxWidth: "480px", boxShadow: "0 10px 25px rgba(0,0,0,0.2)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0 }}>{t("account.billing.transferModal.title")}</h3>
        <p style={{ color: "#6b7280", fontSize: "0.9rem" }}>
          {t("account.billing.transferModal.description")}
        </p>

        <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
          <button
            type="button"
            className={`btn btn-sm${mode === "user" ? " btn-primary" : ""}`}
            onClick={() => setMode("user")}
          >
            {t("account.billing.transferModal.teamMemberTab")}
          </button>
          <button
            type="button"
            className={`btn btn-sm${mode === "partner" ? " btn-primary" : ""}`}
            onClick={() => setMode("partner")}
          >
            {t("account.billing.transferModal.partnerCodeTab")}
          </button>
        </div>

        {mode === "user" ? (
          <label style={{ display: "block", marginBottom: "1rem" }}>
            <span style={{ fontSize: "0.85rem", fontWeight: 600, display: "block", marginBottom: "0.25rem" }}>
              {t("account.billing.transferModal.chooseTeamMember")}
            </span>
            {loadingMembers ? (
              <span style={{ color: "#6b7280" }}>{t("account.billing.transferModal.loadingTeam")}</span>
            ) : members.length === 0 ? (
              <span style={{ color: "#6b7280" }}>{t("account.billing.transferModal.noEligibleMembers")}</span>
            ) : (
              <select
                value={targetUserId}
                onChange={(e) => setTargetUserId(e.target.value)}
                style={{ width: "100%", padding: "0.5rem", fontSize: "0.9rem" }}
              >
                <option value="">{t("account.billing.transferModal.selectPlaceholder")}</option>
                {members.map((m) => {
                  const name = [m.firstName, m.lastName].filter(Boolean).join(" ");
                  return (
                    <option key={m.userId} value={m.userId}>
                      {name ? `${name} (${m.email})` : m.email} · {t(`team.roles.${m.role}`)}
                    </option>
                  );
                })}
              </select>
            )}
          </label>
        ) : (
          <label style={{ display: "block", marginBottom: "1rem" }}>
            <span style={{ fontSize: "0.85rem", fontWeight: 600, display: "block", marginBottom: "0.25rem" }}>
              {t("account.billing.transferModal.partnerCodeLabel")}
            </span>
            <input
              type="text"
              value={partnerCode}
              onChange={(e) => setPartnerCode(e.target.value)}
              placeholder={t("account.billing.transferModal.partnerCodePlaceholder")}
              style={{ width: "100%", padding: "0.5rem", fontSize: "0.9rem", textTransform: "uppercase" }}
            />
            <span style={{ fontSize: "0.8rem", color: "#6b7280", display: "block", marginTop: "0.25rem" }}>
              {t("account.billing.transferModal.partnerCodeHint")}
            </span>
          </label>
        )}

        {error && (
          <div style={{ color: "#dc2626", fontSize: "0.85rem", marginBottom: "0.75rem" }}>{error}</div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
          <button type="button" className="btn" onClick={onClose} disabled={submitting}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleSubmit}
            disabled={submitting}
          >
            {submitting ? t("account.billing.transferModal.transferring") : t("account.billing.transferModal.transfer")}
          </button>
        </div>
      </div>
    </div>
  );
}

function PlanSwitchModal({
  targetPlan,
  targetDetails,
  submitting,
  error,
  onClose,
  onConfirm,
}: {
  targetPlan: "monthly" | "annual";
  targetDetails: BillingPlanDetails;
  submitting: boolean;
  error: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const proratedNote =
    targetPlan === "annual"
      ? t("account.billing.planSwitchModal.annualNote")
      : t("account.billing.planSwitchModal.monthlyNote");
  const price =
    targetDetails.interval === "year"
      ? `$${targetDetails.amountUsd}/yr`
      : `$${targetDetails.amountUsd}/mo`;

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "#fff", borderRadius: "8px", padding: "1.5rem",
          width: "90%", maxWidth: "480px", boxShadow: "0 10px 25px rgba(0,0,0,0.2)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0 }}>{t("account.billing.planSwitchModal.title", { plan: targetDetails.label, price })}</h3>
        <p style={{ color: "#374151", fontSize: "0.95rem", lineHeight: 1.5 }}>{proratedNote}</p>

        {error && (
          <div style={{ color: "#dc2626", fontSize: "0.85rem", marginBottom: "0.75rem" }}>{error}</div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem", marginTop: "1.25rem" }}>
          <button type="button" className="btn" onClick={onClose} disabled={submitting}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onConfirm}
            disabled={submitting}
          >
            {submitting ? t("account.billing.planSwitchModal.switching") : t("account.billing.planSwitchModal.confirm", { plan: targetDetails.label })}
          </button>
        </div>
      </div>
    </div>
  );
}

function CancelSubscriptionModal({
  periodEnd,
  isTrialing,
  submitting,
  onClose,
  onConfirm,
}: {
  periodEnd: string | null;
  isTrialing: boolean;
  submitting: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const endDate = periodEnd ? new Date(periodEnd).toLocaleDateString() : null;
  const message = isTrialing
    ? (endDate
        ? t("account.billing.cancelModal.trialMessageWithDate", { date: endDate })
        : t("account.billing.cancelModal.trialMessageNoDate"))
    : (endDate
        ? t("account.billing.cancelModal.activeMessageWithDate", { date: endDate })
        : t("account.billing.cancelModal.activeMessageNoDate"));

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "#fff", borderRadius: "8px", padding: "1.5rem",
          width: "90%", maxWidth: "480px", boxShadow: "0 10px 25px rgba(0,0,0,0.2)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0 }}>{t("account.billing.cancelModal.title")}</h3>
        <p style={{ color: "#374151", fontSize: "0.95rem", lineHeight: 1.5 }}>{message}</p>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem", marginTop: "1.25rem" }}>
          <button type="button" className="btn" onClick={onClose} disabled={submitting}>
            {t("account.billing.cancelModal.keepSubscription")}
          </button>
          <button
            type="button"
            className="btn"
            style={{ color: "#dc2626", fontWeight: 600 }}
            onClick={onConfirm}
            disabled={submitting}
          >
            {submitting ? t("account.billing.cancelModal.canceling") : t("account.billing.cancelModal.confirmCancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
