import { useState, useEffect } from "react";
import { admin, type PromoItem, type PromoRedemption } from "../lib/api";

const EMPTY_FORM = {
  code: "",
  slug: "",
  name: "",
  type: "free_trial",
  planOverride: "monthly",
  trialDays: 30,
  maxRedemptions: "",
  expiresAt: "",
  isActive: true,
  notes: "",
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function StatusBadge({ active }: { active: boolean }) {
  return (
    <span style={{
      display: "inline-block",
      padding: "0.15rem 0.5rem",
      borderRadius: "4px",
      fontSize: "0.75rem",
      fontWeight: 600,
      background: active ? "#d1fae5" : "#f3f4f6",
      color: active ? "#065f46" : "#6b7280",
    }}>
      {active ? "Active" : "Inactive"}
    </span>
  );
}

export function Promos() {
  const [items, setItems] = useState<PromoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [redemptions, setRedemptions] = useState<Record<string, PromoRedemption[]>>({});
  const [redemptionsLoading, setRedemptionsLoading] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    admin.promotions()
      .then((res) => setItems(res.items))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const openCreate = () => {
    setEditingId(null);
    setForm({ ...EMPTY_FORM });
    setFormError("");
    setShowForm(true);
  };

  const openEdit = (item: PromoItem) => {
    setEditingId(item.id);
    setForm({
      code: item.code,
      slug: item.slug || "",
      name: item.name,
      type: item.type,
      planOverride: item.planOverride || "monthly",
      trialDays: item.trialDays,
      maxRedemptions: item.maxRedemptions !== null ? String(item.maxRedemptions) : "",
      expiresAt: item.expiresAt ? item.expiresAt.slice(0, 10) : "",
      isActive: item.isActive,
      notes: item.notes || "",
    });
    setFormError("");
    setShowForm(true);
  };

  const closeForm = () => { setShowForm(false); setEditingId(null); };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError("");
    setSaving(true);
    try {
      const payload = {
        code: form.code.trim(),
        slug: form.slug.trim() || null,
        name: form.name.trim(),
        type: form.type,
        planOverride: form.planOverride,
        trialDays: Number(form.trialDays),
        maxRedemptions: form.maxRedemptions !== "" ? Number(form.maxRedemptions) : null,
        expiresAt: form.expiresAt || null,
        isActive: form.isActive,
        notes: form.notes.trim() || null,
      };
      if (editingId) {
        await admin.updatePromotion(editingId, payload);
      } else {
        await admin.createPromotion(payload);
      }
      closeForm();
      load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (item: PromoItem) => {
    await admin.updatePromotion(item.id, { isActive: !item.isActive }).catch(() => {});
    load();
  };

  const handleDelete = async (item: PromoItem) => {
    if (!confirm(`Delete promotion "${item.name}"? This cannot be undone.`)) return;
    await admin.deletePromotion(item.id).catch(() => {});
    load();
  };

  const toggleRedemptions = async (id: string) => {
    if (expandedId === id) { setExpandedId(null); return; }
    setExpandedId(id);
    if (!redemptions[id]) {
      setRedemptionsLoading(id);
      const res = await admin.promotionRedemptions(id).catch(() => ({ items: [] }));
      setRedemptions((prev) => ({ ...prev, [id]: res.items }));
      setRedemptionsLoading(null);
    }
  };

  const baseDomain = "cadmus.digital";

  return (
    <div className="page">
      <div className="page-header">
        <h2>Promotions</h2>
        <button className="btn btn-primary" onClick={openCreate}>+ New Promo</button>
      </div>

      {showForm && (
        <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: "8px", padding: "1.5rem", marginBottom: "1.5rem" }}>
          <h3 style={{ marginBottom: "1rem" }}>{editingId ? "Edit Promotion" : "New Promotion"}</h3>
          {formError && <div style={{ color: "#dc2626", marginBottom: "1rem", fontSize: "0.9rem" }}>{formError}</div>}
          <form onSubmit={handleSave}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
              <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.875rem" }}>
                Code *
                <input className="form-input" value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} required placeholder="aisummit2026" />
                <span style={{ color: "#6b7280", fontSize: "0.75rem" }}>Used in ?promo= URL param and at signup</span>
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.875rem" }}>
                Vanity URL slug
                <input className="form-input" value={form.slug} onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))} placeholder="aisummit2026" />
                <span style={{ color: "#6b7280", fontSize: "0.75rem" }}>{form.slug ? `cadmus.digital/go/${form.slug}` : "Leave blank to skip vanity URL"}</span>
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.875rem" }}>
                Display Name *
                <input className="form-input" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required placeholder="AI Summit 2026" />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.875rem" }}>
                Plan
                <select className="form-input" value={form.planOverride} onChange={(e) => setForm((f) => ({ ...f, planOverride: e.target.value }))}>
                  <option value="monthly">Monthly</option>
                  <option value="annual">Annual</option>
                </select>
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.875rem" }}>
                Free trial days
                <input className="form-input" type="number" min={1} value={form.trialDays} onChange={(e) => setForm((f) => ({ ...f, trialDays: Number(e.target.value) }))} required />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.875rem" }}>
                Max redemptions
                <input className="form-input" type="number" min={1} value={form.maxRedemptions} onChange={(e) => setForm((f) => ({ ...f, maxRedemptions: e.target.value }))} placeholder="Unlimited" />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.875rem" }}>
                Expires on
                <input className="form-input" type="date" value={form.expiresAt} onChange={(e) => setForm((f) => ({ ...f, expiresAt: e.target.value }))} />
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.875rem", alignSelf: "end", paddingBottom: "0.5rem" }}>
                <input type="checkbox" checked={form.isActive} onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))} />
                Active
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.875rem", gridColumn: "1 / -1" }}>
                Notes
                <textarea className="form-input" value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} rows={2} placeholder="Internal notes about this promotion" />
              </label>
            </div>
            <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem" }}>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? "Saving…" : "Save"}</button>
              <button type="button" className="btn" onClick={closeForm}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      {loading ? (
        <p style={{ color: "#6b7280" }}>Loading…</p>
      ) : items.length === 0 ? (
        <p style={{ color: "#6b7280" }}>No promotions yet. Create one to get started.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "1px", background: "#f3f4f6", borderRadius: "8px", overflow: "hidden" }}>
          {items.map((item) => (
            <div key={item.id} style={{ background: "#fff" }}>
              <div style={{ padding: "0.875rem 1rem", display: "flex", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                    <span style={{ fontWeight: 600, fontSize: "0.95rem" }}>{item.name}</span>
                    <StatusBadge active={item.isActive} />
                    <code style={{ fontSize: "0.8rem", background: "#f3f4f6", padding: "0.1rem 0.4rem", borderRadius: "4px" }}>{item.code}</code>
                  </div>
                  <div style={{ fontSize: "0.8rem", color: "#6b7280", marginTop: "0.2rem", display: "flex", gap: "1rem", flexWrap: "wrap" }}>
                    <span>{item.trialDays} days free ({item.planOverride})</span>
                    {item.slug && <span>Link: <a href={`https://${baseDomain}/go/${item.slug}`} target="_blank" rel="noopener noreferrer" style={{ color: "#3b82f6" }}>/{item.slug}</a></span>}
                    {item.expiresAt && <span>Expires {formatDate(item.expiresAt)}</span>}
                    {item.maxRedemptions !== null && <span>Limit: {item.maxRedemptions}</span>}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexShrink: 0 }}>
                  <button
                    style={{ fontSize: "0.8rem", color: "#3b82f6", background: "none", border: "none", cursor: "pointer", padding: 0 }}
                    onClick={() => toggleRedemptions(item.id)}
                  >
                    {item.redemptionCount} redemption{item.redemptionCount !== 1 ? "s" : ""} {expandedId === item.id ? "▲" : "▼"}
                  </button>
                  <button className="btn btn-small" onClick={() => openEdit(item)}>Edit</button>
                  <button
                    className="btn btn-small"
                    style={{ background: item.isActive ? "#fef3c7" : "#d1fae5", color: item.isActive ? "#92400e" : "#065f46", border: "none" }}
                    onClick={() => handleToggleActive(item)}
                  >
                    {item.isActive ? "Deactivate" : "Activate"}
                  </button>
                  <button
                    className="btn btn-small"
                    style={{ background: "#fee2e2", color: "#dc2626", border: "none" }}
                    onClick={() => handleDelete(item)}
                  >
                    Delete
                  </button>
                </div>
              </div>

              {expandedId === item.id && (
                <div style={{ padding: "0 1rem 1rem 1rem", borderTop: "1px solid #f3f4f6" }}>
                  {redemptionsLoading === item.id ? (
                    <p style={{ color: "#6b7280", fontSize: "0.85rem" }}>Loading redemptions…</p>
                  ) : !redemptions[item.id] || redemptions[item.id].length === 0 ? (
                    <p style={{ color: "#6b7280", fontSize: "0.85rem", paddingTop: "0.75rem" }}>No redemptions yet.</p>
                  ) : (
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem", marginTop: "0.75rem" }}>
                      <thead>
                        <tr style={{ borderBottom: "1px solid #e5e7eb", textAlign: "left" }}>
                          <th style={{ padding: "0.4rem 0.5rem", fontWeight: 600, color: "#374151" }}>Site</th>
                          <th style={{ padding: "0.4rem 0.5rem", fontWeight: 600, color: "#374151" }}>User</th>
                          <th style={{ padding: "0.4rem 0.5rem", fontWeight: 600, color: "#374151" }}>Redeemed</th>
                          <th style={{ padding: "0.4rem 0.5rem", fontWeight: 600, color: "#374151" }}>IP</th>
                        </tr>
                      </thead>
                      <tbody>
                        {redemptions[item.id].map((r) => (
                          <tr key={r.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
                            <td style={{ padding: "0.4rem 0.5rem" }}>
                              <a href={`/sites/${r.siteId}`} style={{ color: "#3b82f6" }}>{r.siteName}</a>
                              <span style={{ color: "#9ca3af", marginLeft: "0.35rem" }}>({r.subdomain})</span>
                            </td>
                            <td style={{ padding: "0.4rem 0.5rem", color: "#374151" }}>{r.userEmail}</td>
                            <td style={{ padding: "0.4rem 0.5rem", color: "#6b7280" }}>{formatDate(r.redeemedAt)}</td>
                            <td style={{ padding: "0.4rem 0.5rem", color: "#9ca3af" }}>{r.ipAddress || "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
