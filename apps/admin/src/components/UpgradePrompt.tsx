import type { FeatureKey, GateResult } from "../lib/feature-gates";

const FEATURE_LABELS: Record<FeatureKey, string> = {
  custom_domain: "Custom Domain",
  team_members: "Team Members",
  ai_chat_message: "AI Chat Messages",
  ai_image_generation: "AI Image Generation",
  page_count: "Page Limit",
  post_count: "Post Limit",
  storage_upload: "Media Storage",
  form_email_notification: "Form Email Notifications",
  paid_addons: "Paid Add-ons",
};

const FEATURE_DESCRIPTIONS: Record<FeatureKey, string> = {
  custom_domain: "Connect your own domain name to your site.",
  team_members: "Invite collaborators to help manage your site.",
  ai_chat_message: "Chat with Cadmus AI to edit content and get suggestions.",
  ai_image_generation: "Generate professional images using AI.",
  page_count: "Create additional pages on your site.",
  post_count: "Publish additional blog posts.",
  storage_upload: "Upload images, videos, and documents to your media library.",
  form_email_notification: "Receive email notifications when visitors submit forms.",
  paid_addons: "Install premium add-ons from the marketplace.",
};

function periodLabel(period: GateResult["period"]): string {
  if (period === "daily") return "today";
  if (period === "monthly") return "this month";
  if (period === "lifetime") return "total";
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
  const label = FEATURE_LABELS[feature];
  const description = FEATURE_DESCRIPTIONS[feature];
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
              {label}: {gate.usage} / {gate.limit} {periodLabel(gate.period)} used.{" "}
            </>
          ) : (
            <>{label} is not available on the free plan. </>
          )}
          Upgrade to unlock more.
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
          Upgrade
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
          {label} Limit Reached
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
              {gate.usage} / {gate.limit} {periodLabel(gate.period)}
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
        Upgrade Plan
      </a>
      <div
        style={{
          fontSize: "0.75rem",
          color: "var(--color-text-muted, #6b7280)",
        }}
      >
        Unlock unlimited access with a paid plan.
      </div>
    </div>
  );
}
