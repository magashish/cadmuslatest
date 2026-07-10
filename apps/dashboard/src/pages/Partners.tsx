import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { admin, type PartnerListItem, type UserListItem } from "../lib/api";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function Partners() {
  const [items, setItems] = useState<PartnerListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  // Create form state
  const [email, setEmail] = useState("");
  const [matchedUser, setMatchedUser] = useState<UserListItem | null>(null);
  const [lookupState, setLookupState] = useState<"idle" | "searching" | "done">("idle");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [commissionRate, setCommissionRate] = useState("");
  const [commissionsOnAddons, setCommissionsOnAddons] = useState(false);
  const [isAgency, setIsAgency] = useState(false);
  const [createError, setCreateError] = useState("");
  const [creating, setCreating] = useState(false);

  const fetchPartners = async () => {
    setLoading(true);
    try {
      const res = await admin.partners();
      setItems(res.items);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPartners();
  }, []);

  // Debounced lookup: is this email an existing user?
  useEffect(() => {
    const trimmed = email.trim().toLowerCase();
    if (!EMAIL_RE.test(trimmed)) {
      setMatchedUser(null);
      setLookupState("idle");
      return;
    }
    setLookupState("searching");
    const timer = setTimeout(async () => {
      try {
        const res = await admin.users({ search: trimmed, limit: 5 });
        const exact = res.items.find((u) => u.email.toLowerCase() === trimmed) || null;
        setMatchedUser(exact);
      } catch {
        setMatchedUser(null);
      } finally {
        setLookupState("done");
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [email]);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    const trimmedEmail = email.trim().toLowerCase();
    if (!EMAIL_RE.test(trimmedEmail)) {
      setCreateError("Enter a valid email address");
      return;
    }
    if (!name.trim()) {
      setCreateError("Company name is required");
      return;
    }
    if (!code.trim()) {
      setCreateError("Partner code is required");
      return;
    }
    setCreateError("");
    setCreating(true);
    try {
      await admin.createPartner({
        email: trimmedEmail,
        name: name.trim(),
        code: code.trim(),
        commissionRate: commissionRate || undefined,
        commissionsOnAddons,
        isAgency,
      });
      setShowCreate(false);
      setEmail("");
      setMatchedUser(null);
      setLookupState("idle");
      setName("");
      setCode("");
      setCommissionRate("");
      setCommissionsOnAddons(false);
      setIsAgency(false);
      await fetchPartners();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create partner");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <h2>Partners ({items.length})</h2>
        <button className="btn btn-primary" onClick={() => setShowCreate(!showCreate)}>
          {showCreate ? "Cancel" : "Create Partner"}
        </button>
      </div>

      {showCreate && (
        <div className="settings-section" style={{ marginBottom: "1.5rem" }}>
          <h3>Create Partner</h3>
          {createError && <div className="auth-error" style={{ marginTop: "0.5rem" }}>{createError}</div>}
          <form onSubmit={handleCreate} className="settings-form">
            <label>
              Partner Email
              <input
                type="email"
                placeholder="partner@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </label>
            {email.trim() && (
              <p style={{ fontSize: "0.8rem", color: "var(--color-text-muted)", marginTop: "-0.25rem", marginBottom: "0.75rem" }}>
                {lookupState === "searching" && "Checking…"}
                {lookupState === "done" && matchedUser && (
                  <>Existing user — will promote to partner.</>
                )}
                {lookupState === "done" && !matchedUser && EMAIL_RE.test(email.trim()) && (
                  <>New email — creates a partner account and emails them an invite to set their password. (Partner accounts can't go through normal signup.)</>
                )}
                {lookupState === "idle" && !EMAIL_RE.test(email.trim()) && (
                  <>Enter a valid email address.</>
                )}
              </p>
            )}
            <label>
              Company Name
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} required />
            </label>
            <label>
              Partner Code
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="e.g. WEBDEV2026"
                required
              />
            </label>
            <label>
              Commission Rate
              <input
                type="text"
                value={commissionRate}
                onChange={(e) => setCommissionRate(e.target.value)}
                placeholder="e.g. 10%"
              />
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
            <div className="settings-actions">
              <button type="submit" className="btn btn-primary" disabled={creating}>
                {creating ? "Creating..." : "Create"}
              </button>
            </div>
          </form>
        </div>
      )}

      {loading ? (
        <p>Loading...</p>
      ) : items.length === 0 ? (
        <p style={{ color: "var(--color-text-muted)" }}>No partners yet.</p>
      ) : (
        <table className="content-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Code</th>
              <th>Commission</th>
              <th>Status</th>
              <th>Sites</th>
              <th>Referrals</th>
              <th>User</th>
            </tr>
          </thead>
          <tbody>
            {items.map((partner) => (
              <tr key={partner.id}>
                <td>
                  <Link to={`/partners/${partner.id}`}>{partner.name}</Link>
                  {partner.isAgency && (
                    <span className="status-badge status-active" style={{ marginLeft: "0.4rem", fontSize: "0.65rem" }}>agency</span>
                  )}
                </td>
                <td>
                  <code style={{ fontSize: "0.8rem" }}>{partner.code}</code>
                </td>
                <td>
                  {partner.commissionRate || "--"}
                  {partner.commissionRate && partner.commissionsOnAddons && (
                    <div style={{ fontSize: "0.72rem", color: "var(--color-text-muted)" }}>plan + add-ons</div>
                  )}
                </td>
                <td>
                  <span className={`status-badge status-${partner.status}`}>{partner.status}</span>
                </td>
                <td>{partner.siteCount}</td>
                <td>{partner.referralCount}</td>
                <td>{partner.userEmail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
