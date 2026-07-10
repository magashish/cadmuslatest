import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../context/AuthContext";
import { partner, type PartnerOverview } from "../lib/api";

// Partner self-service portal (v1). Standalone page — partners without any
// site membership have no AdminLayout context, so this renders its own chrome.
export function PartnerHome() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const [data, setData] = useState<PartnerOverview | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    partner.overview()
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : t("partnerHome.error.loadFailed")));
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
          {copied === label ? t("partnerHome.copied") : t("partnerHome.copy")}
        </button>
      </div>
      <div style={{ fontSize: "0.8rem", color: "var(--color-text-muted, #666)", marginTop: "0.25rem" }}>{hint}</div>
    </div>
  );

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "2rem 1rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
        <div>
          <h1 style={{ margin: 0 }}>{t("partnerHome.title")}</h1>
          {data && (
            <p style={{ margin: "0.25rem 0 0", color: "var(--color-text-muted, #666)" }}>
              {data.partner.name} · {t("partnerHome.code")} <code>{data.partner.code}</code>
              {data.partner.commissionRate ? (
                <> · {t("partnerHome.commission", { rate: data.partner.commissionRate })}{data.partner.commissionsOnAddons ? ` (${t("partnerHome.planAddons")})` : ""}</>
              ) : ""}
            </p>
          )}
        </div>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <span style={{ fontSize: "0.85rem", color: "var(--color-text-muted, #666)" }}>{user?.email}</span>
          <button type="button" className="btn btn-sm" onClick={logout}>{t("partnerHome.logout")}</button>
        </div>
      </div>

      {error && <div className="auth-error">{error}</div>}

      {data && (
        <>
          <div className="settings-section" style={{ marginBottom: "1.5rem" }}>
            <h3>{t("partnerHome.yourLinks")}</h3>
            <div style={{ marginTop: "0.75rem" }}>
              {linkRow(
                t("partnerHome.referralLinkLabel"),
                `${publicHost}/admin/signup?ref=${encodeURIComponent(data.partner.code)}`,
                t("partnerHome.referralLinkHint")
              )}
              {data.partner.isAgency &&
                linkRow(
                  t("partnerHome.clientInviteLinkLabel"),
                  `${publicHost}/admin/signup?client=${encodeURIComponent(data.partner.code)}`,
                  t("partnerHome.clientInviteLinkHint")
                )}
            </div>
          </div>

          <div className="settings-section" style={{ marginBottom: "1.5rem" }}>
            <h3>{t("partnerHome.referralsTitle", { count: data.referrals.length })}</h3>
            {data.referrals.length === 0 ? (
              <p style={{ color: "var(--color-text-muted, #666)" }}>
                {t("partnerHome.noReferrals")}
              </p>
            ) : (
              <table className="content-table" style={{ marginTop: "0.75rem" }}>
                <thead>
                  <tr>
                    <th>{t("partnerHome.tableSite")}</th>
                    <th>{t("partnerHome.tableStatus")}</th>
                    <th>{t("partnerHome.tableSignedUp")}</th>
                    <th>{t("partnerHome.tableQualified")}</th>
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
              <h3>{t("partnerHome.clientSitesTitle", { count: data.linkedSites.length })}</h3>
              {data.linkedSites.length === 0 ? (
                <p style={{ color: "var(--color-text-muted, #666)" }}>
                  {t("partnerHome.noClientSites")}
                </p>
              ) : (
                <table className="content-table" style={{ marginTop: "0.75rem" }}>
                  <thead>
                    <tr>
                      <th>{t("partnerHome.tableSite")}</th>
                      <th>{t("partnerHome.tableStatus")}</th>
                      <th>{t("partnerHome.tableBilling")}</th>
                      <th>{t("partnerHome.tableLinked")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.linkedSites.map((s) => (
                      <tr key={s.siteId}>
                        <td>{s.siteName}</td>
                        <td><span className={`status-badge status-${s.siteStatus}`}>{s.siteStatus}</span></td>
                        <td>{s.billingActive ? t("partnerHome.yes") : t("partnerHome.notYet")}</td>
                        <td>{formatDate(s.linkedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p style={{ fontSize: "0.8rem", color: "var(--color-text-muted, #666)", marginTop: "0.75rem" }}>
                {t("partnerHome.clientSitesFooter")}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
