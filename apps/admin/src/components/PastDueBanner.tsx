import { useEffect, useState } from "react";
import { billing, type BillingStatus } from "../lib/api";

export function PastDueBanner() {
  const [data, setData] = useState<BillingStatus | null>(null);

  useEffect(() => {
    billing.status().then(setData).catch(() => {});
  }, []);

  if (!data?.subscription) return null;
  if (data.subscription.status !== "past_due") return null;

  const handleUpdatePayment = async () => {
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
        background: "#fef2f2",
        borderBottom: "1px solid #fecaca",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        fontSize: "0.875rem",
        color: "#991b1b",
      }}
    >
      <span>
        Your last payment was declined. Stripe will keep retrying, but your site
        will be suspended if those attempts also fail — please update your card.
      </span>
      <button
        onClick={handleUpdatePayment}
        style={{
          padding: "0.25rem 0.75rem",
          background: "#dc2626",
          color: "#fff",
          border: "none",
          borderRadius: "4px",
          cursor: "pointer",
          fontSize: "0.8125rem",
          fontWeight: 600,
          marginLeft: "0.75rem",
          whiteSpace: "nowrap",
        }}
      >
        Update payment method
      </button>
    </div>
  );
}
