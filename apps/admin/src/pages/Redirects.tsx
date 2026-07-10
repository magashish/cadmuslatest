import { useState, useEffect, useCallback, useRef } from "react";
import { redirects as redirectsApi } from "../lib/api";

interface Redirect {
  id: string;
  fromPath: string;
  toUrl: string;
  statusCode: number;
  enabled: boolean;
}

const STATUS_OPTIONS = [
  { value: 301, label: "301 — Permanent" },
  { value: 302, label: "302 — Temporary" },
  { value: 307, label: "307 — Temporary (preserve method)" },
  { value: 308, label: "308 — Permanent (preserve method)" },
];

function parseCsv(text: string): Array<{ fromPath: string; toUrl: string; statusCode: number }> {
  let lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#"));
  // Auto-detect header row: if the first field doesn't start with "/" it's a header
  if (lines.length > 0 && !lines[0].split(",")[0].trim().replace(/^["']|["']$/g, "").startsWith("/")) {
    lines = lines.slice(1);
  }
  const rows: Array<{ fromPath: string; toUrl: string; statusCode: number }> = [];
  for (const line of lines) {
    const parts = line.split(",").map((p) => p.trim().replace(/^["']|["']$/g, ""));
    if (parts.length < 2) continue;
    const fromPath = parts[0];
    const toUrl = parts[1];
    const statusCode = parts[2] ? parseInt(parts[2], 10) || 301 : 301;
    if (fromPath && toUrl) rows.push({ fromPath, toUrl, statusCode });
  }
  return rows;
}

export function Redirects() {
  const [items, setItems] = useState<Redirect[]>([]);
  const [loading, setLoading] = useState(true);

  const [newFrom, setNewFrom] = useState("");
  const [newTo, setNewTo] = useState("");
  const [newCode, setNewCode] = useState(301);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTo, setEditTo] = useState("");
  const [editCode, setEditCode] = useState(301);
  const [editEnabled, setEditEnabled] = useState(true);

  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ created: number; skipped: number; errors: string[] } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = (await redirectsApi.list()) as { items: Redirect[] };
      setItems(res.items);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFrom.trim() || !newTo.trim()) return;
    setCreating(true);
    setCreateError("");
    try {
      await redirectsApi.create({ fromPath: newFrom.trim(), toUrl: newTo.trim(), statusCode: newCode });
      setNewFrom("");
      setNewTo("");
      setNewCode(301);
      await load();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create redirect");
    } finally {
      setCreating(false);
    }
  };

  const startEdit = (item: Redirect) => {
    setEditingId(item.id);
    setEditTo(item.toUrl);
    setEditCode(item.statusCode);
    setEditEnabled(item.enabled);
  };

  const handleSave = async (id: string) => {
    try {
      await redirectsApi.update(id, { toUrl: editTo.trim(), statusCode: editCode, enabled: editEnabled });
      setItems((prev) => prev.map((r) => r.id === id ? { ...r, toUrl: editTo.trim(), statusCode: editCode, enabled: editEnabled } : r));
      setEditingId(null);
    } catch {
      // silent
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await redirectsApi.delete(id);
      setItems((prev) => prev.filter((r) => r.id !== id));
      setDeleteConfirm(null);
      if (editingId === id) setEditingId(null);
    } catch {
      // silent
    }
  };

  const handleToggleEnabled = async (item: Redirect) => {
    try {
      await redirectsApi.update(item.id, { enabled: !item.enabled });
      setItems((prev) => prev.map((r) => r.id === item.id ? { ...r, enabled: !item.enabled } : r));
    } catch {
      // silent
    }
  };

  const handleFileImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setImportResult(null);
    try {
      const text = await file.text();
      const rows = parseCsv(text);
      if (rows.length === 0) {
        setImportResult({ created: 0, skipped: 0, errors: ["No valid rows found in CSV"] });
        return;
      }
      const result = await redirectsApi.bulkImport(rows);
      setImportResult(result as { created: number; skipped: number; errors: string[] });
      await load();
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const cellStyle = { padding: "0.6rem 0.75rem", borderBottom: "1px solid var(--color-border, #e5e7eb)", verticalAlign: "middle" as const };
  const codeBadge: React.CSSProperties = { display: "inline-block", fontSize: "0.75rem", padding: "1px 6px", borderRadius: "4px", background: "var(--color-surface, #f3f4f6)", fontFamily: "monospace" };

  return (
    <div className="page">
      <div className="page-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h2>URL Redirects</h2>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            style={{ display: "none" }}
            onChange={handleFileImport}
          />
          <button
            type="button"
            className="btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={importing}
          >
            {importing ? "Importing…" : "Import CSV"}
          </button>
        </div>
      </div>

      {importResult && (
        <div style={{ marginBottom: "1rem", padding: "0.75rem 1rem", borderRadius: "6px", background: importResult.errors.length > 0 ? "var(--color-warning-bg, #fef9c3)" : "var(--color-success-bg, #dcfce7)", fontSize: "0.875rem" }}>
          Imported {importResult.created} redirect{importResult.created !== 1 ? "s" : ""}
          {importResult.skipped > 0 && `, skipped ${importResult.skipped}`}
          {importResult.errors.length > 0 && (
            <ul style={{ margin: "0.5rem 0 0", paddingLeft: "1.25rem" }}>
              {importResult.errors.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          )}
        </div>
      )}

      <form onSubmit={handleCreate} className="redirect-form" style={{ display: "grid", gap: "0.5rem", marginBottom: "1rem", gridTemplateColumns: "1fr 1fr 170px auto" }}>
        <input
          type="text"
          value={newFrom}
          onChange={(e) => setNewFrom(e.target.value)}
          placeholder="/old-path"
          disabled={creating}
        />
        <input
          type="text"
          value={newTo}
          onChange={(e) => setNewTo(e.target.value)}
          placeholder="/new-path or https://…"
          disabled={creating}
        />
        <select value={newCode} onChange={(e) => setNewCode(Number(e.target.value))} disabled={creating}>
          {STATUS_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        <button type="submit" className="btn btn-primary" disabled={creating || !newFrom.trim() || !newTo.trim()}>
          {creating ? "Adding…" : "Add"}
        </button>
      </form>
      {createError && (
        <p style={{ color: "var(--color-error, #dc2626)", fontSize: "0.875rem", margin: "-0.5rem 0 1rem" }}>{createError}</p>
      )}

      {loading ? (
        <p style={{ color: "var(--color-text-secondary, #6b7280)" }}>Loading…</p>
      ) : items.length === 0 ? (
        <div style={{ textAlign: "center", padding: "3rem 1rem", color: "var(--color-text-secondary, #6b7280)" }}>
          <p style={{ marginBottom: "0.5rem" }}>No redirects yet.</p>
          <p style={{ fontSize: "0.875rem" }}>Add a redirect above or import from a CSV file.</p>
          <p style={{ fontSize: "0.8rem", marginTop: "1rem", opacity: 0.7 }}>CSV format: <code>from_path, to_url, status_code</code></p>
        </div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
          <thead>
            <tr style={{ borderBottom: "2px solid var(--color-border, #e5e7eb)" }}>
              <th style={{ ...cellStyle, textAlign: "left", fontWeight: 600 }}>From</th>
              <th style={{ ...cellStyle, textAlign: "left", fontWeight: 600 }}>To</th>
              <th style={{ ...cellStyle, textAlign: "center", fontWeight: 600, width: "80px" }}>Code</th>
              <th style={{ ...cellStyle, textAlign: "center", fontWeight: 600, width: "80px" }}>Active</th>
              <th style={{ ...cellStyle, width: "120px" }} />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} style={{ opacity: item.enabled ? 1 : 0.5 }}>
                {editingId === item.id ? (
                  <>
                    <td style={cellStyle}><code style={{ fontSize: "0.85rem" }}>{item.fromPath}</code></td>
                    <td style={cellStyle}>
                      <input type="text" value={editTo} onChange={(e) => setEditTo(e.target.value)} style={{ width: "100%" }} />
                    </td>
                    <td style={{ ...cellStyle, textAlign: "center" }}>
                      <select value={editCode} onChange={(e) => setEditCode(Number(e.target.value))} style={{ fontSize: "0.8rem" }}>
                        {STATUS_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.value}</option>)}
                      </select>
                    </td>
                    <td style={{ ...cellStyle, textAlign: "center" }}>
                      <input type="checkbox" checked={editEnabled} onChange={(e) => setEditEnabled(e.target.checked)} />
                    </td>
                    <td style={{ ...cellStyle, textAlign: "right" }}>
                      <div style={{ display: "flex", gap: "0.25rem", justifyContent: "flex-end" }}>
                        <button type="button" className="btn btn-primary" style={{ fontSize: "0.8rem", padding: "0.2rem 0.5rem" }} onClick={() => handleSave(item.id)}>Save</button>
                        <button type="button" className="btn" style={{ fontSize: "0.8rem", padding: "0.2rem 0.5rem" }} onClick={() => setEditingId(null)}>Cancel</button>
                      </div>
                    </td>
                  </>
                ) : deleteConfirm === item.id ? (
                  <>
                    <td colSpan={4} style={cellStyle}>
                      <span style={{ color: "var(--color-error, #dc2626)" }}>Delete redirect from <code>{item.fromPath}</code>?</span>
                    </td>
                    <td style={{ ...cellStyle, textAlign: "right" }}>
                      <div style={{ display: "flex", gap: "0.25rem", justifyContent: "flex-end" }}>
                        <button type="button" className="btn btn-danger" style={{ fontSize: "0.8rem", padding: "0.2rem 0.5rem" }} onClick={() => handleDelete(item.id)}>Delete</button>
                        <button type="button" className="btn" style={{ fontSize: "0.8rem", padding: "0.2rem 0.5rem" }} onClick={() => setDeleteConfirm(null)}>Cancel</button>
                      </div>
                    </td>
                  </>
                ) : (
                  <>
                    <td style={cellStyle}><code style={{ fontSize: "0.85rem" }}>{item.fromPath}</code></td>
                    <td style={{ ...cellStyle, color: "var(--color-text-secondary, #6b7280)", maxWidth: "300px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.toUrl}</td>
                    <td style={{ ...cellStyle, textAlign: "center" }}><span style={codeBadge}>{item.statusCode}</span></td>
                    <td style={{ ...cellStyle, textAlign: "center" }}>
                      <button
                        type="button"
                        title={item.enabled ? "Enabled — click to disable" : "Disabled — click to enable"}
                        style={{ background: "none", border: "none", cursor: "pointer", fontSize: "1rem", padding: 0 }}
                        onClick={() => handleToggleEnabled(item)}
                      >
                        {item.enabled ? "✓" : "○"}
                      </button>
                    </td>
                    <td style={{ ...cellStyle, textAlign: "right" }}>
                      <div style={{ display: "flex", gap: "0.25rem", justifyContent: "flex-end" }}>
                        <button type="button" className="btn" style={{ fontSize: "0.8rem", padding: "0.2rem 0.5rem" }} onClick={() => startEdit(item)}>Edit</button>
                        <button type="button" className="btn" style={{ fontSize: "0.8rem", padding: "0.2rem 0.5rem" }} onClick={() => setDeleteConfirm(item.id)}>Delete</button>
                      </div>
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
