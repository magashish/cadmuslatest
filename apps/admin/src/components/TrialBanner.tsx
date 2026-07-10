import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { billing, type BillingStatus } from "../lib/api";

export function TrialBanner() {
  const { t } = useTranslation();
  const [data, setData] = useState<BillingStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    billing.status().then(setData).catch(() => {});
  }, []);

  if (!data || dismissed) return null;
  if (data.billing === "free") return null;
  if (!data.subscription) return null;
  if (data.hasPaymentMethod) return null;

  const sub = data.subscription;
  if (sub.status !== "trialing") return null;

  const trialEnd = sub.trialEndsAt ? new Date(sub.trialEndsAt) : null;
  if (!trialEnd) return null;

  const now = new Date();
  const daysLeft = Math.max(0, Math.ceil((trialEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
  const urgent = daysLeft <= 3;

  const handleAddPayment = async () => {
    try {
      const { url } = await billing.createCheckoutSession(window.location.href);
      window.location.href = url;
    } catch {
      // Stripe not configured — silently ignore
    }
  };

  return (
    <div
      style={{
        padding: "0.625rem 1rem",
        marginBottom: "0.75rem",
        background: urgent ? "#fef2f2" : "#fffbeb",
        borderBottom: `1px solid ${urgent ? "#fecaca" : "#fde68a"}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        fontSize: "0.875rem",
        color: urgent ? "#991b1b" : "#92400e",
      }}
    >
      <span>
        {daysLeft === 0
          ? t("trialBanner.endsToday")
          : t("trialBanner.daysLeft", { count: daysLeft })}
      </span>
      <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
        <button
          onClick={handleAddPayment}
          style={{
            padding: "0.25rem 0.75rem",
            background: urgent ? "#dc2626" : "#f59e0b",
            color: "#fff",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer",
            fontSize: "0.8125rem",
            fontWeight: 600,
          }}
        >
          {t("trialBanner.addPaymentMethod")}
        </button>
        {!urgent && (
          <button
            onClick={() => setDismissed(true)}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "#92400e",
              fontSize: "1rem",
              lineHeight: 1,
              padding: "0 0.25rem",
            }}
            aria-label={t("common.dismiss")}
          >
            x
          </button>
        )}
      </div>
    </div>
  );
}
