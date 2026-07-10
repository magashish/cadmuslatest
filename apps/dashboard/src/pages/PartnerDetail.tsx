import { useEffect, useState, type FormEvent } from "react";
import { useParams, Link } from "react-router-dom";
import { admin, type PartnerDetail as PartnerDetailType } from "../lib/api";

export function PartnerDetail() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<PartnerDetailType | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);

  // Edit form state
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [commissionRate, setCommissionRate] = useState("");
  const [commissionsOnAddons, setCommissionsOnAddons] = useState(false);
  const [isAgency, setIsAgency] = useState(false);
  const [billingTogglingId, setBillingTogglingId] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!id) return;
    admin
      .partner(id)
      .then((res) => {
        setData(res);
        setName(res.partner.name);
        setCode(res.partner.code);
        setCommissionRate(res.partner.commissionRate || "");
        setCommissionsOnAddons(res.partner.commissionsOnAddons);
        setIsAgency(res.partner.isAgency);
        setStatus(res.partner.status);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [id]);

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    if (!id) return;
    setSaveError("");
    setSaving(true);
    try {
      await admin.updatePartner(id, { name, code, commissionRate, commissionsOnAddons, isAgency, status });
      const res = await admin.partner(id);
      setData(res);
      setEditing(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

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
        <h2>Partner not found</h2>
        <Link to="/partners">Back to partners</Link>
      </div>
    );
  }

  const { partner, user, linkedSites } = data;

  // Build the partner's shareable signup link. Derive the public host from the
  // dashboard host: dashboard.cadmus.digital → cadmus.digital,
  // dashboard-dev.cadmus.digital → dev.cadmus.digital.
  const host = window.location.hostname;
  const isLocal = host === "localhost" || host.startsWith("127.");
  const publicHost = host.replace(/^dashboard-/, "").replace(/^dashboard\./, "");
  const referralLink = isLocal
    ? `${window.location.origin}/admin/signup?ref=${encodeURIComponent(partner.code)}`
    : `https://${publicHost}/admin/signup?ref=${encodeURIComponent(partner.code)}`;
  const clientInviteLink = referralLink.replace("?ref=", "?client=");

  const copyLink = () => {
    navigator.clipboard.writeText(referralLink).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const formatDate = (d: string) =>
    new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  return (
    <div className="page">
      <div className="page-header">
        <h2>{partner.name}</h2>
        <button className="btn btn-sm" onClick={() => setEditing(!editing)}>
          {editing ? "Cancel" : "Edit"}
        </button>
      </div>

      {editing ? (
        <div className="settings-section">
          <h3>Edit Partner</h3>
          {saveError && <div className="auth-error" style={{ marginTop: "0.5rem" }}>{saveError}</div>}
          <form onSubmit={handleSave} className="settings-form">
            <label>
              Name
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} required />
            </label>
            <label>
              Code
              <input type="text" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} required />
            </label>
            <label>
              Commission Rate
              <input type="text" value={commissionRate} onChange={(e) => setCommissionRate(e.target.value)} />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              {/* .settings-form input is display:block + width:100% — undo both
                  so the checkbox sits inline at its natural size */}
              <input
                type="checkbox"
                checked={commissionsOnAddons}
                onChange={(e) => setCommissionsOnAddons(e.target.checked)}
                style={{ display: "inline-block", width: "auto", margin: 0 }}
              />
              Commission includes add-on revenue (default is plan only)
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <input
                type="checkbox"
                checked={isAgency}
                onChange={(e) => setIsAgency(e.target.checked)}
                style={{ display: "inline-block", width: "auto", margin: 0 }}
              />
              Agency partner — gets a client-invite link that adds them as site admin + billing party
            </label>
            <label>
              Status
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="active">Active</option>
                <option value="suspended">Suspended</option>
              </select>
            </label>
            <div className="settings-actions">
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </form>
        </div>
      ) : (
        <>
          <div className="settings-section">
            <h3>Partner Info</h3>
            <div className="detail-grid" style={{ marginTop: "0.75rem" }}>
              <span className="detail-label">Status</span>
              <span className="detail-value">
                <span className={`status-badge status-${partner.status}`}>{partner.status}</span>
              </span>
              <span className="detail-label">Code</span>
              <span className="detail-value">
                <code>{partner.code}</code>
              </span>
              <span className="detail-label">Referral link</span>
              <span className="detail-value" style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                <code style={{ wordBreak: "break-all" }}>{referralLink}</code>
                <button type="button" className="btn btn-sm" onClick={copyLink}>
                  {copied ? "Copied!" : "Copy"}
                </button>
              </span>
              {partner.isAgency && (
                <>
                  <span className="detail-label">Client invite link</span>
                  <span className="detail-value">
                    <code style={{ wordBreak: "break-all" }}>{clientInviteLink}</code>
                  </span>
                </>
              )}
              <span className="detail-label">Commission</span>
              <span className="detail-value">
                {partner.commissionRate || "--"}
                {partner.commissionRate ? (partner.commissionsOnAddons ? " (plan + add-ons)" : " (plan only)") : ""}
              </span>
              <span className="detail-label">User</span>
              <span className="detail-value">{user.email}</span>
              <span className="detail-label">Created</span>
              <span className="detail-value">{formatDate(partner.createdAt)}</span>
            </div>
          </div>

          <div className="settings-section">
            <h3>Linked Sites ({linkedSites.length})</h3>
            {linkedSites.length === 0 ? (
              <p style={{ marginTop: "0.5rem", color: "var(--color-text-muted)" }}>
                No sites linked to this partner.
              </p>
            ) : (
              <table className="content-table" style={{ marginTop: "0.75rem" }}>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Subdomain</th>
                    <th>Status</th>
                    <th>Billing Active</th>
                    <th>Linked</th>
                  </tr>
                </thead>
                <tbody>
                  {linkedSites.map((site) => (
                    <tr key={site.id}>
                      <td>
                        <Link to={`/sites/${site.id}`}>{site.name}</Link>
                      </td>
                      <td>{site.subdomain}</td>
                      <td>
                        <span className={`status-badge status-${site.status}`}>{site.status}</span>
                      </td>
                      <td>
                        {site.billingActive ? "Yes" : "No"}{" "}
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={billingTogglingId === site.id}
                          onClick={async () => {
                            if (!window.confirm(site.billingActive
                              ? "Mark this site as NOT billed by the partner?"
                              : "Confirm the partner is now the billing party for this site? Do this after billing is actually arranged (partner paid via the site's upgrade flow).")) return;
                            setBillingTogglingId(site.id);
                            try {
                              await admin.setPartnerSiteBilling(partner.id, site.id, !site.billingActive);
                              const res = await admin.partner(partner.id);
                              setData(res);
                            } catch (err) {
                              alert(err instanceof Error ? err.message : "Failed to update");
                            } finally {
                              setBillingTogglingId(null);
                            }
                          }}
                        >
                          {billingTogglingId === site.id ? "…" : site.billingActive ? "Deactivate" : "Activate"}
                        </button>
                      </td>
                      <td>{formatDate(site.linkedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
