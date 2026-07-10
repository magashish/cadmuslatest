import { useAuth } from "../context/AuthContext";

export function SuspensionBanner() {
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
    deletionLine = `Scheduled for permanent deletion on ${dateStr} (${daysLeft} day${daysLeft === 1 ? "" : "s"} remaining).`;
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
        {isArchived ? "This site is archived" : "This site is suspended"}
      </div>
      <div>
        You can still sign in and view content, but editing and publishing are disabled.
        {reason ? ` Reason: ${reason}` : ""}
      </div>
      {deletionLine && <div style={{ marginTop: "0.25rem" }}>{deletionLine}</div>}
      <div style={{ marginTop: "0.25rem" }}>
        Questions? Contact{" "}
        <a href="mailto:support@cadmus.digital" style={{ color: "#7f1d1d", textDecoration: "underline" }}>
          support@cadmus.digital
        </a>
        .
      </div>
    </div>
  );
}
