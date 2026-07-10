import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { submissions } from "../lib/api";
import type { FormSubmission } from "../lib/api";

export function FormSubmissions() {
  const { t } = useTranslation();
  const [items, setItems] = useState<FormSubmission[]>([]);
  const [total, setTotal] = useState(0);
  const [forms, setForms] = useState<{ formIdentifier: string; count: number; name: string | null }[]>([]);
  const [selectedForm, setSelectedForm] = useState<string>("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [offset, setOffset] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const limit = 25;

  const filters = {
    form: selectedForm || undefined,
    from: from ? new Date(from).toISOString() : undefined,
    to: to ? new Date(`${to}T23:59:59.999`).toISOString() : undefined,
    search: search || undefined,
  };

  const loadSubmissions = useCallback(async () => {
    setLoading(true);
    try {
      const result = await submissions.list(filters, limit, offset);
      setItems(result.items);
      setTotal(result.total);
    } catch (err) {
      console.error("Failed to load submissions:", err);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedForm, from, to, search, offset]);

  useEffect(() => {
    loadSubmissions();
  }, [loadSubmissions]);

  useEffect(() => {
    submissions.forms().then((r) => setForms(r.forms)).catch(() => {});
  }, []);

  useEffect(() => {
    setOffset(0);
  }, [selectedForm, from, to, search]);

  const [resendingId, setResendingId] = useState<string | null>(null);

  const handleDelete = async (id: string) => {
    if (!confirm(t("formSubmissions.confirmDelete"))) return;
    try {
      await submissions.delete(id);
      setItems((prev) => prev.filter((s) => s.id !== id));
      setTotal((prev) => prev - 1);
    } catch {
      alert(t("formSubmissions.errors.deleteFailed"));
    }
  };

  const handleResendWebhook = async (id: string) => {
    setResendingId(id);
    try {
      const { submission } = await submissions.resendWebhook(id);
      setItems((prev) => prev.map((s) => (s.id === id ? submission : s)));
    } catch (err) {
      alert(err instanceof Error ? err.message : t("formSubmissions.errors.resendFailed"));
    } finally {
      setResendingId(null);
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      await submissions.exportCsv(filters);
    } catch (err) {
      alert(err instanceof Error ? err.message : t("formSubmissions.errors.exportFailed"));
    } finally {
      setExporting(false);
    }
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSearch(searchInput.trim());
  };

  const handleClearFilters = () => {
    setSelectedForm("");
    setFrom("");
    setTo("");
    setSearch("");
    setSearchInput("");
  };

  const totalPages = Math.ceil(total / limit);
  const currentPage = Math.floor(offset / limit) + 1;
  const hasFilters = Boolean(selectedForm || from || to || search);

  const nameByIdentifier = new Map(forms.map((f) => [f.formIdentifier, f.name]));
  const formLabel = (identifier: string) => nameByIdentifier.get(identifier) || t("formSubmissions.untitledForm");

  const prettifyKey = (key: string) =>
    key
      .replace(/[_-]+/g, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem", flexWrap: "wrap", gap: "0.75rem" }}>
        <h1>{t("formSubmissions.title")}</h1>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <span style={{ fontSize: "0.85rem", color: "#888" }}>{t("formSubmissions.total", { count: total })}</span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={handleExport}
            disabled={exporting || total === 0}
          >
            {exporting ? t("formSubmissions.exporting") : t("formSubmissions.export")}
          </button>
        </div>
      </div>

      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1rem", alignItems: "center" }}>
        <select
          value={selectedForm}
          onChange={(e) => setSelectedForm(e.target.value)}
          style={{ fontSize: "0.9rem", padding: "0.4rem 0.6rem" }}
        >
          <option value="">{t("formSubmissions.allForms")}</option>
          {forms.map((f) => (
            <option key={f.formIdentifier} value={f.formIdentifier}>
              {f.name || t("formSubmissions.untitledForm")} ({f.count})
            </option>
          ))}
        </select>
        <label style={{ fontSize: "0.85rem", color: "#555", display: "flex", alignItems: "center", gap: "0.25rem" }}>
          {t("formSubmissions.from")}
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            style={{ fontSize: "0.9rem", padding: "0.35rem 0.5rem" }}
          />
        </label>
        <label style={{ fontSize: "0.85rem", color: "#555", display: "flex", alignItems: "center", gap: "0.25rem" }}>
          {t("formSubmissions.to")}
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            style={{ fontSize: "0.9rem", padding: "0.35rem 0.5rem" }}
          />
        </label>
        <form onSubmit={handleSearchSubmit} style={{ display: "flex", gap: "0.25rem" }}>
          <input
            type="search"
            placeholder={t("formSubmissions.searchPlaceholder")}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            style={{ fontSize: "0.9rem", padding: "0.4rem 0.6rem", minWidth: "220px" }}
          />
          <button type="submit" className="btn btn-sm">{t("formSubmissions.search")}</button>
        </form>
        {hasFilters && (
          <button type="button" className="btn btn-sm" onClick={handleClearFilters}>
            {t("formSubmissions.clear")}
          </button>
        )}
      </div>

      {loading ? (
        <p style={{ color: "#888" }}>{t("common.loading")}</p>
      ) : items.length === 0 ? (
        <p style={{ color: "#888" }}>{t("formSubmissions.noResults")}</p>
      ) : (
        <>
          <table className="data-table" style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={thStyle}>{t("formSubmissions.columns.date")}</th>
                <th style={thStyle}>{t("formSubmissions.columns.form")}</th>
                <th style={thStyle}>{t("formSubmissions.columns.email")}</th>
                <th style={thStyle}>{t("formSubmissions.columns.source")}</th>
                <th style={{ ...thStyle, width: "60px" }}></th>
              </tr>
            </thead>
            <tbody>
              {items.map((sub) => (
                <>
                  <tr
                    key={sub.id}
                    onClick={() => setExpandedId(expandedId === sub.id ? null : sub.id)}
                    style={{ cursor: "pointer", background: expandedId === sub.id ? "#f7f7f7" : undefined }}
                  >
                    <td style={tdStyle}>{new Date(sub.createdAt).toLocaleDateString()} {new Date(sub.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</td>
                    <td style={tdStyle}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap", fontSize: "0.9rem" }}>
                        {formLabel(sub.formIdentifier)}
                        <WebhookBadge status={sub.webhookStatus} />
                      </span>
                    </td>
                    <td style={tdStyle}>{sub.submitterEmail || "—"}</td>
                    <td style={tdStyle}>
                      {sub.sourceUrl ? (
                        <span title={sub.sourceUrl} style={{ fontSize: "0.85rem", color: "#666" }}>
                          {new URL(sub.sourceUrl).pathname}
                        </span>
                      ) : "—"}
                    </td>
                    <td style={tdStyle}>
                      <button
                        type="button"
                        className="btn btn-sm danger"
                        onClick={(e) => { e.stopPropagation(); handleDelete(sub.id); }}
                      >
                        {t("formSubmissions.delete")}
                      </button>
                    </td>
                  </tr>
                  {expandedId === sub.id && (
                    <tr key={`${sub.id}-detail`}>
                      <td colSpan={5} style={{ padding: "1rem", background: "#fafafa", borderBottom: "1px solid #eee" }}>
                        <table style={{ width: "100%", fontSize: "0.9rem" }}>
                          <tbody>
                            {Object.entries(sub.data).map(([key, value]) => (
                              <tr key={key}>
                                <td style={{ padding: "4px 12px 4px 0", fontWeight: 600, width: "150px", verticalAlign: "top" }}>{prettifyKey(key)}</td>
                                <td style={{ padding: "4px 0", whiteSpace: "pre-wrap" }}>{value}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {(sub.attachments?.length ?? 0) > 0 && (
                          <div style={{ marginTop: "0.75rem", paddingTop: "0.75rem", borderTop: "1px solid #eee" }}>
                            <span style={{ fontWeight: 600, fontSize: "0.85rem" }}>{t("formSubmissions.attachments")}</span>
                            <ul style={{ margin: "0.4rem 0 0", paddingLeft: "1.2rem", fontSize: "0.85rem" }}>
                              {sub.attachments!.map((att, i) => (
                                <li key={i} style={{ marginBottom: "0.25rem" }}>
                                  <button
                                    type="button"
                                    className="btn-link"
                                    style={{ background: "none", border: "none", padding: 0, color: "var(--color-primary, #2563eb)", cursor: "pointer", textDecoration: "underline", font: "inherit" }}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      submissions.downloadAttachment(sub.id, i, att.filename).catch((err) => {
                                        alert(err instanceof Error ? err.message : t("formSubmissions.errors.downloadFailed"));
                                      });
                                    }}
                                  >
                                    {att.filename}
                                  </button>{" "}
                                  <span style={{ color: "#999" }}>({Math.max(1, Math.round(att.size / 1024))} KB)</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {sub.ipAddress && (
                          <p style={{ fontSize: "0.8rem", color: "#999", marginTop: "0.5rem", marginBottom: 0 }}>
                            {t("formSubmissions.ipLabel")} {sub.ipAddress}
                          </p>
                        )}
                        {sub.webhookStatus && (
                          <div style={{ marginTop: "0.75rem", paddingTop: "0.75rem", borderTop: "1px solid #eee", display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
                            <WebhookBadge status={sub.webhookStatus} />
                            {sub.webhookStatus === "failed" && sub.webhookError && (
                              <span style={{ fontSize: "0.8rem", color: "#991b1b" }}>{sub.webhookError}</span>
                            )}
                            {sub.webhookStatus !== "pending" && (
                              <button
                                type="button"
                                className="btn btn-sm"
                                disabled={resendingId === sub.id}
                                onClick={(e) => { e.stopPropagation(); handleResendWebhook(sub.id); }}
                              >
                                {resendingId === sub.id ? t("formSubmissions.resending") : t("formSubmissions.resendWebhook")}
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>

          {totalPages > 1 && (
            <div style={{ display: "flex", justifyContent: "center", gap: "0.5rem", marginTop: "1.5rem" }}>
              <button
                type="button"
                className="btn btn-sm"
                disabled={currentPage <= 1}
                onClick={() => setOffset(Math.max(0, offset - limit))}
              >
                {t("common.previous")}
              </button>
              <span style={{ lineHeight: "2rem", fontSize: "0.9rem" }}>
                {t("common.pageOf", { page: currentPage, total: totalPages })}
              </span>
              <button
                type="button"
                className="btn btn-sm"
                disabled={currentPage >= totalPages}
                onClick={() => setOffset(offset + limit)}
              >
                {t("common.next")}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "0.6rem 0.75rem",
  borderBottom: "2px solid #eee",
  fontSize: "0.85rem",
  fontWeight: 600,
  color: "#555",
};

const tdStyle: React.CSSProperties = {
  padding: "0.6rem 0.75rem",
  borderBottom: "1px solid #eee",
  fontSize: "0.9rem",
};

const WEBHOOK_BADGE: Record<string, { labelKey: string; color: string; bg: string }> = {
  pending: { labelKey: "formSubmissions.webhookStatus.pending", color: "#92400e", bg: "#fef3c7" },
  success: { labelKey: "formSubmissions.webhookStatus.success", color: "#065f46", bg: "#d1fae5" },
  failed: { labelKey: "formSubmissions.webhookStatus.failed", color: "#991b1b", bg: "#fee2e2" },
};

function WebhookBadge({ status }: { status: string | null }) {
  const { t } = useTranslation();
  if (!status) return null;
  const b = WEBHOOK_BADGE[status];
  if (!b) return null;
  return (
    <span style={{ display: "inline-block", padding: "0.1rem 0.45rem", borderRadius: 4, fontSize: "0.72rem", fontWeight: 600, color: b.color, background: b.bg, whiteSpace: "nowrap" }}>
      {t(b.labelKey)}
    </span>
  );
}
