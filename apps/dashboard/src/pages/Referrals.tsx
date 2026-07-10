import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { admin, type ReferralItem } from "../lib/api";

export function Referrals() {
  const [items, setItems] = useState<ReferralItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("");
  const [rewardingId, setRewardingId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const fetchReferrals = () => {
    setLoading(true);
    admin
      .referrals({ status: statusFilter })
      .then((res) => setItems(res.items))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchReferrals();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  const formatDate = (d: string | null) =>
    d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "--";

  const daysSince = (d: string | null): number | null => {
    if (!d) return null;
    return Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000);
  };

  const handleReward = async (ref: ReferralItem) => {
    const who = ref.partnerName || ref.referrerEmail;
    const rate = ref.commissionRate ? ` at ${ref.commissionRate}% commission` : "";
    if (
      !window.confirm(
        `Mark this referral as rewarded?\n\nThis records that ${who} has been paid out${rate} for ${ref.siteName || ref.siteSubdomain}. Do this AFTER the payout (e.g. Stripe balance credit) is actually made.`
      )
    ) {
      return;
    }
    setError("");
    setRewardingId(ref.id);
    try {
      await admin.rewardReferral(ref.id);
      fetchReferrals();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to mark rewarded");
    } finally {
      setRewardingId(null);
    }
  };

  return (
    <div className="page">
      <h2>Referrals ({items.length})</h2>

      <div className="filter-bar">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="qualified">Qualified</option>
          <option value="rewarded">Rewarded</option>
        </select>
      </div>

      {error && <div className="auth-error" style={{ marginBottom: "0.75rem" }}>{error}</div>}

      {loading ? (
        <p>Loading...</p>
      ) : items.length === 0 ? (
        <p style={{ color: "var(--color-text-muted)" }}>No referrals found.</p>
      ) : (
        <table className="content-table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Referrer</th>
              <th>Referred Site</th>
              <th>Plan</th>
              <th>Commission</th>
              <th>Status</th>
              <th>Qualified</th>
              <th>Rewarded</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((ref) => {
              const qualifiedDays = daysSince(ref.qualifiedAt);
              // Payable only once the server-computed clawback window has passed
              const eligible = !!ref.rewardEligibleAt && new Date(ref.rewardEligibleAt) <= new Date();
              return (
                <tr key={ref.id}>
                  <td>
                    <code style={{ fontSize: "0.8rem" }}>{ref.referralCode}</code>
                  </td>
                  <td>
                    {ref.partnerName ? (
                      <>
                        {ref.partnerName}
                        <div style={{ fontSize: "0.75rem", color: "var(--color-text-muted)" }}>{ref.referrerEmail}</div>
                      </>
                    ) : (
                      ref.referrerEmail
                    )}
                  </td>
                  <td>
                    <Link to={`/sites/${ref.siteId}`}>{ref.siteName || ref.siteSubdomain}</Link>
                  </td>
                  <td>{ref.sitePlan}</td>
                  <td>
                    {ref.commissionRate ? `${ref.commissionRate}%` : "--"}
                    {ref.commissionRate && (
                      <div style={{ fontSize: "0.72rem", color: "var(--color-text-muted)" }}>
                        {ref.commissionsOnAddons ? "plan + add-ons" : "plan only"}
                      </div>
                    )}
                  </td>
                  <td>
                    <span className={`status-badge status-${ref.status}`}>{ref.status}</span>
                  </td>
                  <td title={qualifiedDays !== null ? `${qualifiedDays} day${qualifiedDays === 1 ? "" : "s"} ago` : undefined}>
                    {formatDate(ref.qualifiedAt)}
                    {ref.status === "qualified" && qualifiedDays !== null && (
                      <div style={{ fontSize: "0.72rem", color: "var(--color-text-muted)" }}>
                        {qualifiedDays}d ago
                      </div>
                    )}
                  </td>
                  <td>{formatDate(ref.rewardedAt)}</td>
                  <td>
                    {ref.status === "qualified" &&
                      (eligible ? (
                        <button
                          className="btn btn-sm"
                          disabled={rewardingId === ref.id}
                          onClick={() => handleReward(ref)}
                        >
                          {rewardingId === ref.id ? "Saving…" : "Mark rewarded"}
                        </button>
                      ) : (
                        <span
                          style={{ fontSize: "0.75rem", color: "var(--color-text-muted)", whiteSpace: "nowrap" }}
                          title="Inside the 45-day clawback window"
                        >
                          Eligible {formatDate(ref.rewardEligibleAt)}
                        </span>
                      ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
