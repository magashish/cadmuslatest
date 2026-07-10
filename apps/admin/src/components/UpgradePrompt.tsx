import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { FeatureKey, GateResult } from "../lib/feature-gates";

function getFeatureLabels(t: TFunction): Record<FeatureKey, string> {
  return {
    custom_domain: t("upgradePrompt.features.custom_domain.label"),
    team_members: t("upgradePrompt.features.team_members.label"),
    ai_chat_message: t("upgradePrompt.features.ai_chat_message.label"),
    ai_image_generation: t("upgradePrompt.features.ai_image_generation.label"),
    page_count: t("upgradePrompt.features.page_count.label"),
    post_count: t("upgradePrompt.features.post_count.label"),
    storage_upload: t("upgradePrompt.features.storage_upload.label"),
    form_email_notification: t("upgradePrompt.features.form_email_notification.label"),
    paid_addons: t("upgradePrompt.features.paid_addons.label"),
  };
}

function getFeatureDescriptions(t: TFunction): Record<FeatureKey, string> {
  return {
    custom_domain: t("upgradePrompt.features.custom_domain.description"),
    team_members: t("upgradePrompt.features.team_members.description"),
    ai_chat_message: t("upgradePrompt.features.ai_chat_message.description"),
    ai_image_generation: t("upgradePrompt.features.ai_image_generation.description"),
    page_count: t("upgradePrompt.features.page_count.description"),
    post_count: t("upgradePrompt.features.post_count.description"),
    storage_upload: t("upgradePrompt.features.storage_upload.description"),
    form_email_notification: t("upgradePrompt.features.form_email_notification.description"),
    paid_addons: t("upgradePrompt.features.paid_addons.description"),
  };
}

function periodLabel(period: GateResult["period"], t: TFunction): string {
  if (period === "daily") return t("upgradePrompt.period.today");
  if (period === "monthly") return t("upgradePrompt.period.thisMonth");
  if (period === "lifetime") return t("upgradePrompt.period.total");
  return "";
}

function usagePercent(gate: GateResult): number {
  if (gate.limit === null || gate.limit === 0 || gate.usage === null) return 100;
  return Math.min(100, Math.round((gate.usage / gate.limit) * 100));
}

interface UpgradePromptProps {
  feature: FeatureKey;
  gate: GateResult;
  inline?: boolean;
}

export function UpgradePrompt({ feature, gate, inline = false }: UpgradePromptProps) {
  const { t } = useTranslation();
  const label = getFeatureLabels(t)[feature];
  const description = getFeatureDescriptions(t)[feature];
  const pct = usagePercent(gate);
  const hasUsageInfo = gate.limit !== null && gate.usage !== null;

  if (inline) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
          padding: "0.5rem 0.75rem",
          background: "var(--color-warning-bg, #fffbeb)",
          border: "1px solid var(--color-warning-border, #fde68a)",
          borderRadius: "6px",
          fontSize: "0.8125rem",
          color: "var(--color-warning-text, #92400e)",
        }}
      >
        <span style={{ flex: 1 }}>
          {hasUsageInfo ? (
            <>
              {t("upgradePrompt.inline.usage", { label, usage: gate.usage, limit: gate.limit, period: periodLabel(gate.period, t) })}{" "}
            </>
          ) : (
            <>{t("upgradePrompt.inline.notAvailable", { label })} </>
          )}
          {t("upgradePrompt.inline.upgradeToUnlock")}
        </span>
        <a
          href="/admin/account"
          style={{
            padding: "0.25rem 0.625rem",
            background: "var(--color-primary, #1a1a1a)",
            color: "#fff",
            borderRadius: "4px",
            textDecoration: "none",
            fontWeight: 600,
            fontSize: "0.8125rem",
            whiteSpace: "nowrap",
          }}
        >
          {t("upgradePrompt.upgradeButton")}
        </a>
      </div>
    );
  }

  // Card variant
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "1rem",
        padding: "2rem",
        background: "var(--color-card-bg, #fff)",
        border: "1px solid var(--color-border, #e5e7eb)",
        borderRadius: "10px",
        boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
        maxWidth: "380px",
        margin: "0 auto",
        textAlign: "center",
      }}
    >
      <div
        style={{
          width: "48px",
          height: "48px",
          borderRadius: "50%",
          background: "var(--color-warning-bg, #fffbeb)",
          border: "1px solid var(--color-warning-border, #fde68a)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "1.5rem",
        }}
      >
        ⚡
      </div>

      <div>
        <div
          style={{
            fontWeight: 700,
            fontSize: "1rem",
            color: "var(--color-text, #111)",
            marginBottom: "0.375rem",
          }}
        >
          {t("upgradePrompt.card.limitReached", { label })}
        </div>
        <div
          style={{
            fontSize: "0.875rem",
            color: "var(--color-text-muted, #6b7280)",
            lineHeight: 1.5,
          }}
        >
          {description}
        </div>
      </div>

      {hasUsageInfo && (
        <div style={{ width: "100%" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: "0.75rem",
              color: "var(--color-text-muted, #6b7280)",
              marginBottom: "0.375rem",
            }}
          >
            <span>
              {t("upgradePrompt.card.usageFraction", { usage: gate.usage, limit: gate.limit, period: periodLabel(gate.period, t) })}
            </span>
            <span>{pct}%</span>
          </div>
          <div
            style={{
              height: "6px",
              borderRadius: "3px",
              background: "var(--color-border, #e5e7eb)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${pct}%`,
                borderRadius: "3px",
                background: pct >= 100 ? "var(--color-danger, #dc2626)" : "var(--color-warning, #f59e0b)",
                transition: "width 0.3s ease",
              }}
            />
          </div>
        </div>
      )}

      <a
        href="/settings?tab=billing"
        style={{
          display: "inline-block",
          padding: "0.625rem 1.5rem",
          background: "var(--color-primary, #1a1a1a)",
          color: "#fff",
          borderRadius: "6px",
          textDecoration: "none",
          fontWeight: 600,
          fontSize: "0.9375rem",
          width: "100%",
          boxSizing: "border-box",
        }}
      >
        {t("upgradePrompt.card.upgradePlanButton")}
      </a>
      <div
        style={{
          fontSize: "0.75rem",
          color: "var(--color-text-muted, #6b7280)",
        }}
      >
        {t("upgradePrompt.card.unlockText")}
      </div>
    </div>
  );
}
