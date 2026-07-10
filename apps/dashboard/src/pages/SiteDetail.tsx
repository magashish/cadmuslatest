import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { admin, type SiteDetail as SiteDetailType } from "../lib/api";

// Dashboard hostname → matching admin base domain
// dashboard.cadmus.digital → cadmus.digital; dashboard-dev.cadmus.digital → dev.cadmus.digital
function adminBaseUrl(): string {
  const h = typeof window !== "undefined" ? window.location.hostname : "";
  if (h === "dashboard.cadmus.digital") return "https://cadmus.digital";
  if (h === "dashboard-dev.cadmus.digital") return "https://dev.cadmus.digital";
  return window.location.origin.replace(/:\d+$/, ":3000");
}

// Public URL for a site, matching the Cloudflare Worker's per-env convention.
// Prod: {subdomain}.cadmus.digital
// Dev:  {subdomain}--dev.cadmus.digital (single-level subdomain under SSL cert)
function siteUrl(subdomain: string): string {
  const h = typeof window !== "undefined" ? window.location.hostname : "";
  if (h === "dashboard-dev.cadmus.digital") return `${subdomain}--dev.cadmus.digital`;
  return `${subdomain}.cadmus.digital`;
}

export function SiteDetail() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<SiteDetailType | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"overview" | "team" | "activity">("overview");
  const [statusModal, setStatusModal] = useState<null | "suspend" | "reinstate" | "archive" | "restore" | "restartOnboarding">(null);
  const [statusReason, setStatusReason] = useState("");
  const [statusConfirm, setStatusConfirm] = useState("");
  const [statusSubmitting, setStatusSubmitting] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [graceDays, setGraceDays] = useState<30 | 60 | 90>(30);

  // Staff override
  const [overridePlan, setOverridePlan] = useState("");
  const [overrideStatus, setOverrideStatus] = useState("");
  const [overrideSubmitting, setOverrideSubmitting] = useState(false);
  const [overrideResult, setOverrideResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    if (!id) return;
    admin
      .site(id)
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [id]);

  function openStatusModal(kind: "suspend" | "reinstate" | "archive" | "restore" | "restartOnboarding") {
    setStatusModal(kind);
    setStatusReason("");
    setStatusConfirm("");
    setStatusError(null);
    setGraceDays(30);
  }

  function closeStatusModal() {
    if (statusSubmitting) return;
    setStatusModal(null);
  }

  async function submitStatusChange() {
    if (!id || !data || !statusModal) return;
    if (statusConfirm.trim() !== "CONFIRM") {
      setStatusError('Type CONFIRM to proceed.');
      return;
    }
    const requiresReason = statusModal === "suspend" || statusModal === "archive";
    if (requiresReason && !statusReason.trim()) {
      setStatusError("A reason is required.");
      return;
    }

    setStatusSubmitting(true);
    setStatusError(null);
    try {
      if (statusModal === "restartOnboarding") {
        const { site } = await admin.restartOnboarding(id);
        setData({ ...data, site });
      } else {
        const nextStatus =
          statusModal === "suspend"
            ? "suspended"
            : statusModal === "archive"
              ? "archived"
              : "active";
        const { site } = await admin.setSiteStatus(id, {
          status: nextStatus,
          reason: requiresReason ? statusReason.trim() : undefined,
          graceDays: statusModal === "archive" ? graceDays : undefined,
        });
        setData({ ...data, site });
      }
      setStatusModal(null);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : "Failed to change status");
    } finally {
      setStatusSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="page">
        <p>Loading...</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="page">
        <h2>Site not found</h2>
        <Link to="/sites">Back to sites</Link>
      </div>
    );
  }

  const { site, subscription, team, recentActivity, counts } = data;

  async function submitOverride() {
    if (!id || (!overridePlan && !overrideStatus)) return;
    setOverrideSubmitting(true);
    setOverrideResult(null);
    try {
      await admin.overrideSite(id, {
        plan: overridePlan || undefined,
        status: overrideStatus || undefined,
      });
      // Refresh site data
      const fresh = await admin.site(id);
      setData(fresh);
      setOverridePlan("");
      setOverrideStatus("");
      setOverrideResult({ ok: true, message: "Override applied." });
    } catch (err) {
      setOverrideResult({ ok: false, message: err instanceof Error ? err.message : "Failed" });
    } finally {
      setOverrideSubmitting(false);
    }
  }

  const formatDate = (d: string | null) =>
    d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "--";

  const daysUntil = (d: string) =>
    Math.max(0, Math.ceil((new Date(d).getTime() - Date.now()) / (1000 * 60 * 60 * 24)));

  const formatDateTime = (d: string) =>
    new Date(d).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });

  const openAdmin = async () => {
    // Open the tab synchronously (so the popup blocker doesn't eat it), then
    // navigate it once we have a handoff token that carries our admin session
    // across to the admin app's origin.
    const tab = window.open("", "_blank");
    try {
      const { token } = await admin.siteAccess(site.id);
      const url = `${adminBaseUrl()}/admin?handoff=${encodeURIComponent(token)}`;
      if (tab) tab.location.href = url;
      else window.location.href = url;
    } catch {
      tab?.close();
      alert("Couldn't open the site admin. Please try again.");
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <h2>{site.name}</h2>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          {site.status === "active" && (
            <>
              <button className="btn btn-sm" onClick={() => openStatusModal("restartOnboarding")}>
                Restart Onboarding
              </button>
              <button className="btn btn-sm btn-danger" onClick={() => openStatusModal("suspend")}>
                Suspend
              </button>
              <button className="btn btn-sm btn-danger" onClick={() => openStatusModal("archive")}>
                Archive
              </button>
            </>
          )}
          {site.status === "suspended" && (
            <>
              <button className="btn btn-sm" onClick={() => openStatusModal("reinstate")}>
                Reinstate
              </button>
              <button className="btn btn-sm btn-danger" onClick={() => openStatusModal("archive")}>
                Archive
              </button>
            </>
          )}
          {site.status === "archived" && (
            <button className="btn btn-sm" onClick={() => openStatusModal("restore")}>
              Restore
            </button>
          )}
          {site.status === "onboarding" && (
            <>
              <button className="btn btn-sm" onClick={() => openStatusModal("reinstate")}>
                Activate
              </button>
              <button className="btn btn-sm btn-danger" onClick={() => openStatusModal("suspend")}>
                Suspend
              </button>
              <button className="btn btn-sm btn-danger" onClick={() => openStatusModal("archive")}>
                Archive
              </button>
            </>
          )}
          <button type="button" onClick={openAdmin} className="btn btn-sm">
            Open Admin
          </button>
        </div>
      </div>

      {site.status === "suspended" && (
        <div
          className="card"
          style={{
            marginBottom: "1rem",
            borderLeft: "4px solid var(--color-danger, #c0392b)",
            background: "rgba(192, 57, 43, 0.05)",
          }}
        >
          <strong>
            Site suspended
            {site.suspensionSource && (
              <span
                style={{
                  marginLeft: "0.5rem",
                  fontSize: "0.75rem",
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  padding: "0.125rem 0.5rem",
                  borderRadius: "999px",
                  background: site.suspensionSource === "billing" ? "#fef2f2" : "#f3f4f6",
                  color: site.suspensionSource === "billing" ? "#991b1b" : "#374151",
                  border: `1px solid ${site.suspensionSource === "billing" ? "#fecaca" : "#d1d5db"}`,
                }}
              >
                {site.suspensionSource}
              </span>
            )}
          </strong>
          {site.suspensionReason && <p style={{ margin: "0.25rem 0 0" }}>{site.suspensionReason}</p>}
          {site.suspendedAt && (
            <p style={{ margin: "0.25rem 0 0", color: "var(--color-text-muted)", fontSize: "0.875rem" }}>
              Since {formatDate(site.suspendedAt)}
            </p>
          )}
        </div>
      )}

      {site.status === "archived" && (
        <div
          className="card"
          style={{
            marginBottom: "1rem",
            borderLeft: "4px solid var(--color-danger, #c0392b)",
            background: "rgba(192, 57, 43, 0.05)",
          }}
        >
          <strong>Site archived</strong>
          {site.archiveReason && <p style={{ margin: "0.25rem 0 0" }}>{site.archiveReason}</p>}
          {site.hardDeleteAt && (
            <p style={{ margin: "0.25rem 0 0", color: "var(--color-text-muted)", fontSize: "0.875rem" }}>
              Scheduled for permanent deletion on {formatDate(site.hardDeleteAt)}
              {" "}({daysUntil(site.hardDeleteAt)} days remaining)
            </p>
          )}
        </div>
      )}

      <div className="tabs">
        <button
          className={`tab ${activeTab === "overview" ? "active" : ""}`}
          onClick={() => setActiveTab("overview")}
        >
          Overview
        </button>
        <button
          className={`tab ${activeTab === "team" ? "active" : ""}`}
          onClick={() => setActiveTab("team")}
        >
          Team ({team.length})
        </button>
        <button
          className={`tab ${activeTab === "activity" ? "active" : ""}`}
          onClick={() => setActiveTab("activity")}
        >
          Activity
        </button>
      </div>

      {activeTab === "overview" && (
        <div>
          <div className="settings-section">
            <h3>Site Info</h3>
            <div className="detail-grid" style={{ marginTop: "0.75rem" }}>
              <span className="detail-label">Status</span>
              <span className="detail-value">
                <span className={`status-badge status-${site.status}`}>{site.status}</span>
              </span>
              <span className="detail-label">Subdomain</span>
              <span className="detail-value">
                <a href={`https://${siteUrl(site.subdomain)}`} target="_blank" rel="noreferrer">
                  {siteUrl(site.subdomain)}
                </a>
              </span>
              <span className="detail-label">Custom Domain</span>
              <span className="detail-value">{site.domain || "--"}</span>
              <span className="detail-label">Created</span>
              <span className="detail-value">{formatDate(site.createdAt)}</span>
            </div>
          </div>

          <div className="settings-section">
            <h3>Subscription</h3>
            <div className="detail-grid" style={{ marginTop: "0.75rem" }}>
              <span className="detail-label">Billing</span>
              <span className="detail-value" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <span className={`status-badge status-${site.billing === "free" ? "active" : "draft"}`}>
                  {site.billing}
                </span>
              </span>
            </div>
            <p style={{ marginTop: "0.5rem", color: "var(--color-text-muted)", fontSize: "0.8rem" }}>
              Billing mode follows the plan — set the plan to <code>comped</code> in Staff Controls
              for an internal / forever-free site (no Stripe). There's no separate billing toggle.
            </p>
            {site.billing === "free" ? (
              <p style={{ marginTop: "0.5rem", color: "var(--color-text-muted)" }}>
                {site.plan === "comped"
                  ? "Comped site — all features unlocked, no Stripe subscription."
                  : "Billing-free site — no Stripe subscription."}
              </p>
            ) : subscription ? (
              <div className="detail-grid" style={{ marginTop: "0.75rem" }}>
                <span className="detail-label">Status</span>
                <span className="detail-value">
                  <span className={`status-badge status-${subscription.status}`}>
                    {subscription.status}
                  </span>
                </span>
                <span className="detail-label">Trial Ends</span>
                <span className="detail-value">{formatDate(subscription.trialEndsAt)}</span>
                <span className="detail-label">Period End</span>
                <span className="detail-value">{formatDate(subscription.currentPeriodEnd)}</span>
                <span className="detail-label">Stripe Customer</span>
                <span className="detail-value">{subscription.stripeCustomerId}</span>
                <span className="detail-label">Cancel at End</span>
                <span className="detail-value">{subscription.cancelAtPeriodEnd ? "Yes" : "No"}</span>
              </div>
            ) : (
              <p style={{ marginTop: "0.5rem", color: "var(--color-text-muted)" }}>No subscription</p>
            )}
          </div>

          <div className="stat-cards">
            <div className="stat-card">
              <div className="stat-card-value">{counts.content}</div>
              <div className="stat-card-label">Content Items</div>
            </div>
            <div className="stat-card">
              <div className="stat-card-value">{counts.media}</div>
              <div className="stat-card-label">Media Files</div>
            </div>
          </div>

          <div className="settings-section">
            <h3>Staff Controls</h3>
            <p style={{ color: "var(--color-text-muted)", fontSize: "0.875rem", margin: "0.5rem 0 1rem" }}>
              Override plan and status directly. This bypasses normal transition rules and is logged to the audit trail. Setting the plan to <code>comped</code> unlocks every feature and switches billing to <code>free</code> (no Stripe) — use it for internal / forever-free sites, distinct from the limited <code>free</code> tier.
            </p>
            <div className="detail-grid" style={{ marginTop: "0.75rem" }}>
              <span className="detail-label">Current Plan</span>
              <span className="detail-value">
                <code>{site.plan}</code>
              </span>
              <span className="detail-label">Current Status</span>
              <span className="detail-value">
                <span className={`status-badge status-${site.status}`}>{site.status}</span>
              </span>
            </div>
            <div style={{ display: "flex", gap: "0.75rem", marginTop: "1rem", flexWrap: "wrap", alignItems: "flex-end" }}>
              <div className="form-group" style={{ margin: 0 }}>
                <label htmlFor="override-plan" style={{ fontSize: "0.8rem", fontWeight: 600, display: "block", marginBottom: "0.25rem" }}>
                  Plan
                </label>
                <select
                  id="override-plan"
                  value={overridePlan}
                  onChange={(e) => { setOverridePlan(e.target.value); setOverrideResult(null); }}
                  disabled={overrideSubmitting}
                  style={{ minWidth: "130px" }}
                >
                  <option value="">(no change)</option>
                  <option value="free">free (limited tier)</option>
                  <option value="monthly">monthly</option>
                  <option value="annual">annual</option>
                  <option value="comped">comped (internal — unlimited, no billing)</option>
                </select>
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label htmlFor="override-status" style={{ fontSize: "0.8rem", fontWeight: 600, display: "block", marginBottom: "0.25rem" }}>
                  Status
                </label>
                <select
                  id="override-status"
                  value={overrideStatus}
                  onChange={(e) => { setOverrideStatus(e.target.value); setOverrideResult(null); }}
                  disabled={overrideSubmitting}
                  style={{ minWidth: "130px" }}
                >
                  <option value="">(no change)</option>
                  <option value="onboarding">onboarding</option>
                  <option value="free">free</option>
                  <option value="active">active</option>
                  <option value="suspended">suspended</option>
                  <option value="archived">archived</option>
                </select>
              </div>
              <button
                className="btn btn-sm btn-primary"
                onClick={submitOverride}
                disabled={overrideSubmitting || (!overridePlan && !overrideStatus)}
                style={{ marginBottom: "0" }}
              >
                {overrideSubmitting ? "Applying…" : "Apply"}
              </button>
            </div>
            {overrideResult && (
              <p style={{
                marginTop: "0.5rem",
                color: overrideResult.ok ? "#16a34a" : "var(--color-danger, #c0392b)",
                fontSize: "0.875rem",
              }}>
                {overrideResult.message}
              </p>
            )}
          </div>
        </div>
      )}

      {activeTab === "team" && (
        <table className="content-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Name</th>
              <th>Role</th>
              <th>Status</th>
              <th>Joined</th>
            </tr>
          </thead>
          <tbody>
            {team.map((member) => (
              <tr key={member.id}>
                <td>{member.email}</td>
                <td>
                  {`${member.firstName || ""} ${member.lastName || ""}`.trim() || "--"}
                </td>
                <td>
                  <span className={`status-badge status-${member.role === "owner" ? "active" : "draft"}`}>
                    {member.role}
                  </span>
                </td>
                <td>{member.status}</td>
                <td>{formatDate(member.joinedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {activeTab === "activity" && (
        <div className="card">
          <div className="activity-feed">
            {recentActivity.length === 0 ? (
              <p style={{ color: "var(--color-text-muted)" }}>No recent activity.</p>
            ) : (
              recentActivity.map((entry) => (
                <div key={entry.id} className="activity-item">
                  <span>
                    <strong>{entry.actorType}</strong> {entry.action}
                    {entry.entityType && ` on ${entry.entityType}`}
                  </span>
                  <span className="activity-time">{formatDateTime(entry.createdAt)}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}


      {statusModal && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={closeStatusModal}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 100,
          }}
        >
          <div
            className="card"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: "480px", width: "90%", padding: "1.5rem" }}
          >
            <h3 style={{ marginTop: 0 }}>
              {statusModal === "suspend" && "Suspend site"}
              {statusModal === "reinstate" && (site.status === "onboarding" ? "Activate site" : "Reinstate site")}
              {statusModal === "archive" && "Archive site"}
              {statusModal === "restore" && "Restore from archive"}
              {statusModal === "restartOnboarding" && "Restart onboarding"}
            </h3>
            {statusModal === "suspend" && (
              <p style={{ color: "var(--color-text-muted)" }}>
                <strong>{site.name}</strong> will become read-only. The owner and team can sign
                in and view content but cannot publish or edit. Public visitors will see a
                suspension notice.
              </p>
            )}
            {statusModal === "reinstate" && (
              <p style={{ color: "var(--color-text-muted)" }}>
                <strong>{site.name}</strong> will be set to active. Editing and publishing
                resume, and the public site will be served normally.
              </p>
            )}
            {statusModal === "archive" && (
              <p style={{ color: "var(--color-text-muted)" }}>
                <strong>{site.name}</strong> will be archived and scheduled for permanent
                deletion. All content, media, and member access will be removed when the
                grace period ends. You can restore the site any time before then.
              </p>
            )}
            {statusModal === "restore" && (
              <p style={{ color: "var(--color-text-muted)" }}>
                <strong>{site.name}</strong> will be restored to active. Scheduled deletion is
                cancelled and the site resumes normal operation.
              </p>
            )}
            {statusModal === "restartOnboarding" && (
              <p style={{ color: "var(--color-text-muted)" }}>
                <strong>{site.name}</strong> will be moved back into the onboarding wizard. All
                existing content, media, and settings are preserved — the owner will simply land
                in the wizard on their next sign-in so the brief can be reworked and a new design 
                can be generated.
              </p>
            )}

            {statusModal === "archive" && (
              <div className="form-group" style={{ marginTop: "1rem" }}>
                <label htmlFor="grace-days">Grace period before deletion</label>
                <select
                  id="grace-days"
                  value={graceDays}
                  onChange={(e) => setGraceDays(Number(e.target.value) as 30 | 60 | 90)}
                  disabled={statusSubmitting}
                >
                  <option value={30}>30 days</option>
                  <option value={60}>60 days</option>
                  <option value={90}>90 days</option>
                </select>
              </div>
            )}

            {(statusModal === "suspend" || statusModal === "archive") && (
              <div className="form-group" style={{ marginTop: "1rem" }}>
                <label htmlFor="status-reason">Reason (shown to the owner)</label>
                <textarea
                  id="status-reason"
                  value={statusReason}
                  onChange={(e) => setStatusReason(e.target.value)}
                  rows={3}
                  placeholder={
                    statusModal === "suspend"
                      ? "e.g. Non-payment, policy violation, owner request"
                      : "e.g. Owner request, account closure, duplicate site"
                  }
                  disabled={statusSubmitting}
                />
              </div>
            )}

            <div className="form-group" style={{ marginTop: "1rem" }}>
              <label htmlFor="status-confirm">
                Type <strong>CONFIRM</strong> to proceed
              </label>
              <input
                id="status-confirm"
                type="text"
                value={statusConfirm}
                onChange={(e) => setStatusConfirm(e.target.value)}
                disabled={statusSubmitting}
                autoComplete="off"
              />
            </div>

            {statusError && (
              <p style={{ color: "var(--color-danger, #c0392b)", marginTop: "0.75rem" }}>
                {statusError}
              </p>
            )}

            <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end", marginTop: "1.25rem" }}>
              <button className="btn btn-sm" onClick={closeStatusModal} disabled={statusSubmitting}>
                Cancel
              </button>
              <button
                className={`btn btn-sm ${statusModal === "suspend" || statusModal === "archive" ? "btn-danger" : "btn-primary"}`}
                onClick={submitStatusChange}
                disabled={statusSubmitting || statusConfirm.trim() !== "CONFIRM"}
              >
                {statusSubmitting
                  ? "Working..."
                  : statusModal === "suspend"
                    ? "Suspend site"
                    : statusModal === "archive"
                      ? "Archive site"
                      : statusModal === "restore"
                        ? "Restore site"
                        : statusModal === "restartOnboarding"
                          ? "Restart onboarding"
                          : site.status === "onboarding"
                            ? "Activate site"
                            : "Reinstate site"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
