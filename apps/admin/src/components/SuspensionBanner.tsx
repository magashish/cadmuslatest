import { useTranslation } from "react-i18next";
import { useAuth } from "../context/AuthContext";

export function SuspensionBanner() {
  const { t } = useTranslation();
  const { siteStatus, suspensionReason, archiveReason, hardDeleteAt } = useAuth();

  if (siteStatus !== "suspended" && siteStatus !== "archived") return null;

  const isArchived = siteStatus === "archived";
  const reason = isArchived ? archiveReason : suspensionReason;

  let deletionLine: string | null = null;
  if (isArchived && hardDeleteAt) {
    const deleteDate = new Date(hardDeleteAt);
    const daysLeft = Math.max(
      0,
      Math.ceil((deleteDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)),
    );
    const dateStr = deleteDate.toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
    deletionLine = t("suspensionBanner.deletion", { date: dateStr, count: daysLeft });
  }

  return (
    <div
      role="alert"
      style={{
        padding: "0.75rem 1rem",
        marginBottom: "0.75rem",
        background: "#fef2f2",
        borderLeft: "4px solid #b91c1c",
        color: "#7f1d1d",
        fontSize: "0.875rem",
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: "0.25rem" }}>
        {isArchived ? t("suspensionBanner.archivedTitle") : t("suspensionBanner.suspendedTitle")}
      </div>
      <div>
        {t("suspensionBanner.body")}
        {reason ? t("suspensionBanner.reasonSuffix", { reason }) : ""}
      </div>
      {deletionLine && <div style={{ marginTop: "0.25rem" }}>{deletionLine}</div>}
      <div style={{ marginTop: "0.25rem" }}>
        {t("suspensionBanner.contactPrefix")}{" "}
        <a href="mailto:support@cadmus.digital" style={{ color: "#7f1d1d", textDecoration: "underline" }}>
          support@cadmus.digital
        </a>
        .
      </div>
    </div>
  );
}
