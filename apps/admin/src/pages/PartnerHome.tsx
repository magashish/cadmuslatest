import { useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { partner, type PartnerOverview } from "../lib/api";

// Partner self-service portal (v1). Standalone page — partners without any
// site membership have no AdminLayout context, so this renders its own chrome.
export function PartnerHome() {
  const { user, logout } = useAuth();
  const [data, setData] = useState<PartnerOverview | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    partner.overview()
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load"));
  }, []);

  const publicHost = window.location.hostname.startsWith("localhost")
    ? window.location.origin
    : `https://${window.location.hostname.replace(/^admin[.-]/, "")}`;

  const copy = (label: string, value: string) => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    });
  };

  const formatDate = (d: string | null) =>
    d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "--";

  const linkRow = (label: string, url: string, hint: string) => (
    <div style={{ marginBottom: "1rem" }}>
      <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.25rem" }}>{label}</div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
        <code style={{ wordBreak: "break-all", fontSize: "0.85rem" }}>{url}</code>
        <button type="button" className="btn btn-sm" onClick={() => copy(label, url)}>
          {copied === label ? "Copied!" : "Copy"}
        </button>
      </div>
      <div style={{ fontSize: "0.8rem", color: "var(--color-text-muted, #666)", marginTop: "0.25rem" }}>{hint}</div>
    </div>
  );

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "2rem 1rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
        <div>
          <h1 style={{ margin: 0 }}>Cadmus Partner</h1>
          {data && (
            <p style={{ margin: "0.25rem 0 0", color: "var(--color-text-muted, #666)" }}>
              {data.partner.name} · code <code>{data.partner.code}</code>
              {data.partner.commissionRate ? ` · ${data.partner.commissionRate}% commission${data.partner.commissionsOnAddons ? " (plan + add-ons)" : ""}` : ""}
            </p>
          )}
        </div>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <span style={{ fontSize: "0.85rem", color: "var(--color-text-muted, #666)" }}>{user?.email}</span>
          <button type="button" className="btn btn-sm" onClick={logout}>Log out</button>
        </div>
      </div>

      {error && <div className="auth-error">{error}</div>}

      {data && (
        <>
          <div className="settings-section" style={{ marginBottom: "1.5rem" }}>
            <h3>Your links</h3>
            <div style={{ marginTop: "0.75rem" }}>
              {linkRow(
                "Referral link",
                `${publicHost}/admin/signup?ref=${encodeURIComponent(data.partner.code)}`,
                "Anyone who signs up through this link is attributed to you for commission."
              )}
              {data.partner.isAgency &&
                linkRow(
                  "Client invite link",
                  `${publicHost}/admin/signup?client=${encodeURIComponent(data.partner.code)}`,
                  "For your clients: you're added as an admin on their new site and manage its billing."
                )}
            </div>
          </div>

          <div className="settings-section" style={{ marginBottom: "1.5rem" }}>
            <h3>Referrals ({data.referrals.length})</h3>
            {data.referrals.length === 0 ? (
              <p style={{ color: "var(--color-text-muted, #666)" }}>
                No referrals yet — share your referral link to get started.
              </p>
            ) : (
              <table className="content-table" style={{ marginTop: "0.75rem" }}>
                <thead>
                  <tr>
                    <th>Site</th>
                    <th>Status</th>
                    <th>Signed up</th>
                    <th>Qualified</th>
                  </tr>
                </thead>
                <tbody>
                  {data.referrals.map((r) => (
                    <tr key={r.id}>
                      <td>{r.siteName}</td>
                      <td><span className={`status-badge status-${r.status}`}>{r.status}</span></td>
                      <td>{formatDate(r.createdAt)}</td>
                      <td>{formatDate(r.qualifiedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {data.partner.isAgency && (
            <div className="settings-section">
              <h3>Client sites ({data.linkedSites.length})</h3>
              {data.linkedSites.length === 0 ? (
                <p style={{ color: "var(--color-text-muted, #666)" }}>
                  No client sites yet — share your client invite link.
                </p>
              ) : (
                <table className="content-table" style={{ marginTop: "0.75rem" }}>
                  <thead>
                    <tr>
                      <th>Site</th>
                      <th>Status</th>
                      <th>Billing by you</th>
                      <th>Linked</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.linkedSites.map((s) => (
                      <tr key={s.siteId}>
                        <td>{s.siteName}</td>
                        <td><span className={`status-badge status-${s.siteStatus}`}>{s.siteStatus}</span></td>
                        <td>{s.billingActive ? "Yes" : "Not yet"}</td>
                        <td>{formatDate(s.linkedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p style={{ fontSize: "0.8rem", color: "var(--color-text-muted, #666)", marginTop: "0.75rem" }}>
                You're an admin on each client site — log in and pick the site from the site switcher to manage it or set up billing from its Account page.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
