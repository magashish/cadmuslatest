import { useState, useEffect } from "react";
import { admin, type AddonItem } from "../lib/api";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CATEGORIES = ["security", "content", "integrations", "tools"];

const EMPTY_FORM = {
  slug: "",
  name: "",
  tagline: "",
  description: "",
  category: "",
  pricing: "free" as "free" | "paid",
  priceMonthly: "", // dollars
  priceAnnual: "", // dollars
  sortOrder: 0,
};

function centsToDollars(cents: number | null): string {
  if (cents === null || cents === undefined) return "";
  return (cents / 100).toString();
}

function formatPrice(item: AddonItem): string {
  if (item.isFree) return "Free";
  const mo = item.priceMonthlyCents !== null ? `$${(item.priceMonthlyCents / 100).toFixed(2)}/mo` : "";
  const yr = item.priceAnnualCents !== null ? `$${(item.priceAnnualCents / 100).toFixed(2)}/yr` : "";
  return [mo, yr].filter(Boolean).join(" · ") || "—";
}

export function Addons() {
  const [items, setItems] = useState<AddonItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [rowError, setRowError] = useState("");

  const load = () => {
    setLoading(true);
    admin.addons()
      .then((res) => setItems(res.items))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const openCreate = () => {
    setEditingId(null);
    setForm({ ...EMPTY_FORM });
    setFormError("");
    setRowError("");
    setShowForm(true);
  };

  const openEdit = (item: AddonItem) => {
    setEditingId(item.id);
    setForm({
      slug: item.slug,
      name: item.name,
      tagline: item.tagline || "",
      description: item.description || "",
      category: item.category || "",
      pricing: item.isFree ? "free" : "paid",
      priceMonthly: centsToDollars(item.priceMonthlyCents),
      priceAnnual: centsToDollars(item.priceAnnualCents),
      sortOrder: item.sortOrder,
    });
    setFormError("");
    setRowError("");
    setShowForm(true);
  };

  const closeForm = () => { setShowForm(false); setEditingId(null); };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError("");
    setRowError("");

    const slug = form.slug.trim().toLowerCase();
    if (!editingId && !SLUG_RE.test(slug)) {
      setFormError("Slug must be kebab-case (e.g. my-add-on) — lowercase letters, numbers, and single hyphens.");
      return;
    }
    if (!form.name.trim()) {
      setFormError("Name is required.");
      return;
    }

    const isFree = form.pricing === "free";
    let priceMonthlyCents: number | null = null;
    let priceAnnualCents: number | null = null;
    if (!isFree) {
      const mo = Number(form.priceMonthly);
      const yr = Number(form.priceAnnual);
      if (!mo || mo <= 0 || !yr || yr <= 0) {
        setFormError("Paid add-ons require a monthly and annual price greater than $0.");
        return;
      }
      priceMonthlyCents = Math.round(mo * 100);
      priceAnnualCents = Math.round(yr * 100);
    }

    setSaving(true);
    try {
      if (editingId) {
        await admin.updateAddon(editingId, {
          name: form.name.trim(),
          tagline: form.tagline.trim() || null,
          description: form.description.trim() || null,
          category: form.category.trim() || null,
          isFree,
          priceMonthlyCents,
          priceAnnualCents,
          sortOrder: Number(form.sortOrder),
        });
      } else {
        await admin.createAddon({
          slug,
          name: form.name.trim(),
          tagline: form.tagline.trim() || null,
          description: form.description.trim() || null,
          category: form.category.trim() || null,
          isFree,
          priceMonthlyCents,
          priceAnnualCents,
          sortOrder: Number(form.sortOrder),
        });
      }
      closeForm();
      load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleStatus = async (item: AddonItem, status: string) => {
    setRowError("");
    try {
      await admin.updateAddon(item.id, { status });
      load();
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "Update failed");
    }
  };

  const handleDelete = async (item: AddonItem) => {
    if (!confirm(`Delete add-on "${item.name}"? This cannot be undone.`)) return;
    setRowError("");
    try {
      await admin.deleteAddon(item.id);
      load();
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "Delete failed");
    }
  };

  const th: React.CSSProperties = { padding: "0.5rem 0.75rem", fontWeight: 600, color: "#374151", textAlign: "left" };
  const td: React.CSSProperties = { padding: "0.6rem 0.75rem", verticalAlign: "top" };
  const labelStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.875rem" };
  const hint: React.CSSProperties = { color: "#6b7280", fontSize: "0.75rem" };

  return (
    <div className="page">
      <div className="page-header">
        <h2>Manage Add-ons</h2>
        <button className="btn btn-primary" onClick={openCreate}>+ New Add-on</button>
      </div>

      {rowError && (
        <div style={{ color: "#dc2626", marginBottom: "1rem", fontSize: "0.9rem" }}>{rowError}</div>
      )}

      {showForm && (
        <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: "8px", padding: "1.5rem", marginBottom: "1.5rem" }}>
          <h3 style={{ marginBottom: "1rem" }}>{editingId ? "Edit Add-on" : "New Add-on"}</h3>
          {formError && <div style={{ color: "#dc2626", marginBottom: "1rem", fontSize: "0.9rem" }}>{formError}</div>}
          <form onSubmit={handleSave}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
              <label style={labelStyle}>
                Name *
                <input className="form-input" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required placeholder="SEO Booster" />
              </label>
              <label style={labelStyle}>
                Slug *
                <input
                  className="form-input"
                  value={form.slug}
                  onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))}
                  required
                  disabled={!!editingId}
                  placeholder="seo-booster"
                />
                <span style={hint}>{editingId ? "Slug can't change after creation." : "Kebab-case. Can't change after creation."}</span>
              </label>
              <label style={labelStyle}>
                Tagline
                <input className="form-input" value={form.tagline} onChange={(e) => setForm((f) => ({ ...f, tagline: e.target.value }))} placeholder="One-line pitch" />
              </label>
              <label style={labelStyle}>
                Category
                <input className="form-input" list="addon-categories" value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))} placeholder="tools" />
                <datalist id="addon-categories">
                  {CATEGORIES.map((c) => <option key={c} value={c} />)}
                </datalist>
              </label>
              <label style={{ ...labelStyle, gridColumn: "1 / -1" }}>
                Description
                <textarea className="form-input" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={3} placeholder="What does this add-on do?" />
              </label>
              <label style={{ ...labelStyle, gridColumn: "1 / -1", flexDirection: "row", gap: "1.5rem", alignItems: "center" }}>
                <span style={{ fontWeight: 500 }}>Pricing</span>
                <label style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                  <input type="radio" name="pricing" checked={form.pricing === "free"} onChange={() => setForm((f) => ({ ...f, pricing: "free" }))} />
                  Free
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                  <input type="radio" name="pricing" checked={form.pricing === "paid"} onChange={() => setForm((f) => ({ ...f, pricing: "paid" }))} />
                  Paid
                </label>
              </label>
              {form.pricing === "paid" && (
                <>
                  <label style={labelStyle}>
                    Monthly price ($)
                    <input className="form-input" type="number" min={0} step="0.01" value={form.priceMonthly} onChange={(e) => setForm((f) => ({ ...f, priceMonthly: e.target.value }))} placeholder="9.00" />
                  </label>
                  <label style={labelStyle}>
                    Annual price ($)
                    <input
                      className="form-input"
                      type="number"
                      min={0}
                      step="0.01"
                      value={form.priceAnnual}
                      onChange={(e) => setForm((f) => ({ ...f, priceAnnual: e.target.value }))}
                      placeholder={form.priceMonthly ? String((Number(form.priceMonthly) * 10).toFixed(2)) : "90.00"}
                    />
                    <span style={hint}>Suggested: 10× monthly.</span>
                  </label>
                </>
              )}
              <label style={labelStyle}>
                Sort order
                <input className="form-input" type="number" value={form.sortOrder} onChange={(e) => setForm((f) => ({ ...f, sortOrder: Number(e.target.value) }))} />
                <span style={hint}>Lower sorts first.</span>
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
        <p style={{ color: "#6b7280" }}>No add-ons yet. Create one to get started.</p>
      ) : (
        <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: "8px", overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #e5e7eb", background: "#f9fafb" }}>
                <th style={th}>Name</th>
                <th style={th}>Slug</th>
                <th style={th}>Category</th>
                <th style={th}>Price</th>
                <th style={th}>Status</th>
                <th style={th}>Installs</th>
                <th style={th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
                  <td style={td}>
                    <div style={{ fontWeight: 600 }}>{item.name}</div>
                    {item.tagline && <div style={{ color: "#6b7280", fontSize: "0.8rem", marginTop: "0.15rem" }}>{item.tagline}</div>}
                  </td>
                  <td style={td}>
                    <code style={{ fontSize: "0.8rem", background: "#f3f4f6", padding: "0.1rem 0.4rem", borderRadius: "4px" }}>{item.slug}</code>
                  </td>
                  <td style={{ ...td, color: "#374151" }}>{item.category || "—"}</td>
                  <td style={{ ...td, color: "#374151" }}>{formatPrice(item)}</td>
                  <td style={td}>
                    <span className={`status-badge status-${item.status}`}>{item.status}</span>
                  </td>
                  <td style={{ ...td, color: "#374151" }}>{item.activeInstallCount}</td>
                  <td style={td}>
                    <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                      <button className="btn btn-small" onClick={() => openEdit(item)}>Edit</button>
                      {item.status === "draft" && (
                        <button className="btn btn-small" style={{ background: "#d1fae5", color: "#065f46", border: "none" }} onClick={() => handleStatus(item, "published")}>Publish</button>
                      )}
                      {item.status === "published" && (
                        <button className="btn btn-small" style={{ background: "#fef3c7", color: "#92400e", border: "none" }} onClick={() => handleStatus(item, "archived")}>Archive</button>
                      )}
                      {item.status === "archived" && (
                        <button className="btn btn-small" onClick={() => handleStatus(item, "draft")}>Restore to draft</button>
                      )}
                      <button className="btn btn-small" style={{ background: "#fee2e2", color: "#dc2626", border: "none" }} onClick={() => handleDelete(item)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
