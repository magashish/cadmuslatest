import { useState, useEffect, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { content, collections, importHTML, site } from "../lib/api";

type ContentTab = "page" | "post";

interface ContentItem {
  id: string;
  slug: string;
  status: string;
  schemaData: { title?: string; [key: string]: unknown };
  updatedAt: string;
}

type StatusFilter = "all" | "draft" | "published" | "archive";

export function ContentList() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const debugMode = new URLSearchParams(window.location.search).get("debug") === "true";
  const [activeTab, setActiveTab] = useState<ContentTab>("page");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [items, setItems] = useState<ContentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [collectionMap, setCollectionMap] = useState<Record<string, { id: string; name: string }[]>>({});
  const [refreshToken, setRefreshToken] = useState(0);

  // HTML Import modal state
  const [showImportModal, setShowImportModal] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importTitle, setImportTitle] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Theme setup state
  const [importStep, setImportStep] = useState<"loading" | "theme" | "upload">("upload");
  const [themeMode, setThemeMode] = useState<"extract" | "brief">("extract");
  const [themeBrief, setThemeBrief] = useState("");
  const [needsTheme, setNeedsTheme] = useState(false);

  const tabs: ContentTab[] = ["page", "post"];
  const statuses: StatusFilter[] = ["all", "draft", "published", "archive"];

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    const status = statusFilter === "archive" ? "archived" : statusFilter === "all" ? undefined : statusFilter;
    content
      .list(activeTab, status)
      .then(async (res) => {
        let results = (res.items as ContentItem[]) || [];
        if (statusFilter === "all") {
          results = results.filter((i) => i.status !== "archived");
        }
        setItems(results);

        const map: Record<string, { id: string; name: string }[]> = {};
        await Promise.all(
          results.map((item) =>
            collections
              .forContent(item.id)
              .then((r) => {
                const cols = (r.items as { id: string; name: string }[]) || [];
                if (cols.length > 0) map[item.id] = cols;
              })
              .catch(() => {})
          )
        );
        setCollectionMap(map);
      })
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [user, activeTab, statusFilter, refreshToken]);

  useEffect(() => {
    const handler = () => setRefreshToken((n) => n + 1);
    window.addEventListener("cadmus:content-updated", handler);
    return () => window.removeEventListener("cadmus:content-updated", handler);
  }, []);

  const handleDelete = async (id: string) => {
    try {
      await content.delete(id, user?.id);
      setItems((prev) => prev.filter((item) => item.id !== id));
    } catch {
      // silently fail
    }
  };

  const handleUnarchive = async (id: string) => {
    try {
      await content.unarchive(id, user?.id);
      setItems((prev) => prev.filter((item) => item.id !== id));
    } catch {
      // silently fail
    }
  };

  const openImportModal = async () => {
    setShowImportModal(true);
    setImportStep("loading");
    setImportFile(null);
    setImportTitle("");
    setImportError(null);
    setThemeMode("extract");
    setThemeBrief("");
    setNeedsTheme(false);

    if (user?.siteId) {
      try {
        const siteData = await site.get(user.siteId);
        const hasTheme = !!(siteData as Record<string, unknown> & { settings?: { theme?: unknown } }).settings?.theme;
        setNeedsTheme(!hasTheme);
        setImportStep(hasTheme ? "upload" : "theme");
      } catch {
        setImportStep("upload");
      }
    } else {
      setImportStep("upload");
    }
  };

  const closeImportModal = () => {
    if (importing) return;
    setShowImportModal(false);
  };

  const handleFileDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file && file.name.toLowerCase().match(/\.html?$/)) {
      setImportFile(file);
      setImportError(null);
    } else {
      setImportError("Please drop an HTML file (.html or .htm).");
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] || null;
    if (file) {
      setImportFile(file);
      setImportError(null);
    }
  };

  const handleImport = async () => {
    if (!importFile || !user?.siteId) return;
    setImporting(true);
    setImportError(null);
    try {
      const result = await importHTML.importFile(
        user.siteId,
        importFile,
        importTitle || undefined,
        needsTheme ? themeMode : undefined,
        needsTheme && themeMode === "brief" ? themeBrief : undefined,
      );
      setShowImportModal(false);
      navigate(`/content/${result.pageId}`);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <h2>Content</h2>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          {debugMode && (
            <button className="btn" onClick={openImportModal}>
              Import HTML
            </button>
          )}
          <Link to={`/content/new?type=${activeTab}`} className="btn btn-primary">
            + New {activeTab}
          </Link>
        </div>
      </div>

      <div className="tabs">
        {tabs.map((tab) => (
          <button
            key={tab}
            className={`tab ${activeTab === tab ? "active" : ""}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}s
          </button>
        ))}
      </div>

      <div className="content-filters">
        {statuses.map((s) => (
          <button
            key={s}
            className={`btn btn-sm ${statusFilter === s ? "btn-primary" : ""}`}
            onClick={() => setStatusFilter(s)}
          >
            {s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      {loading ? (
        <p>Loading...</p>
      ) : items.length === 0 ? (
        <div className="content-list">
          <p>
            No {activeTab}s yet.{" "}
            <Link to={`/content/new?type=${activeTab}`}>Create your first one</Link> or ask the AI to generate content.
          </p>
        </div>
      ) : (
        <table className="content-table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Slug</th>
              <th>Collections</th>
              <th>Status</th>
              <th>Updated</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>
                  <Link to={`/content/${item.id}`}>
                    {item.schemaData?.title || "Untitled"}
                  </Link>
                </td>
                <td>{item.slug}</td>
                <td style={{ color: "var(--color-text-secondary)" }}>
                  {collectionMap[item.id]?.map((c) => c.name).join(", ") || "—"}
                </td>
                <td>
                  <span className={`status-badge status-${item.status}`}>
                    {item.status}
                  </span>
                </td>
                <td>{new Date(item.updatedAt).toLocaleDateString()}</td>
                <td className="content-actions">
                  {item.status === "archived" ? (
                    <button
                      className="btn btn-sm"
                      onClick={() => handleUnarchive(item.id)}
                    >
                      Restore
                    </button>
                  ) : (
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() => handleDelete(item.id)}
                    >
                      Archive
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* HTML Import Modal */}
      {showImportModal && (
        <div
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100,
          }}
          onClick={closeImportModal}
        >
          <div
            style={{
              background: "var(--color-surface, #fff)",
              borderRadius: "8px",
              padding: "1.5rem",
              width: "90%",
              maxWidth: "500px",
              boxShadow: "0 10px 25px rgba(0,0,0,0.2)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginTop: 0, marginBottom: "1rem" }}>Import HTML Page</h3>

            {/* Step: loading (checking site) */}
            {importStep === "loading" && (
              <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "1rem 0", color: "var(--color-text-secondary)" }}>
                <span style={{
                  display: "inline-block", width: "16px", height: "16px",
                  border: "2px solid var(--color-primary, #3b82f6)",
                  borderTopColor: "transparent",
                  borderRadius: "50%",
                  animation: "spin 0.8s linear infinite",
                  flexShrink: 0,
                }} />
                <span>Checking site…</span>
              </div>
            )}

            {/* Step: theme setup */}
            {importStep === "theme" && (
              <div>
                <p style={{ marginTop: 0, fontSize: "0.9rem", color: "var(--color-text-secondary)" }}>
                  Your site doesn't have a theme yet. Choose how to set one up:
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", marginBottom: "1rem" }}>
                  <label style={{
                    display: "flex", alignItems: "flex-start", gap: "0.75rem",
                    padding: "0.875rem 1rem",
                    border: `2px solid ${themeMode === "extract" ? "var(--color-primary, #3b82f6)" : "var(--color-border, #d1d5db)"}`,
                    borderRadius: "6px",
                    cursor: "pointer",
                    background: themeMode === "extract" ? "rgba(59,130,246,0.04)" : "transparent",
                  }}>
                    <input
                      type="radio"
                      name="themeMode"
                      value="extract"
                      checked={themeMode === "extract"}
                      onChange={() => setThemeMode("extract")}
                      style={{ marginTop: "2px" }}
                    />
                    <div>
                      <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>Extract from my page</div>
                      <div style={{ fontSize: "0.8rem", color: "var(--color-text-secondary)", marginTop: "0.2rem" }}>
                        AI will detect your colors, fonts, and header/footer from the imported HTML.
                      </div>
                    </div>
                  </label>
                  <label style={{
                    display: "flex", alignItems: "flex-start", gap: "0.75rem",
                    padding: "0.875rem 1rem",
                    border: `2px solid ${themeMode === "brief" ? "var(--color-primary, #3b82f6)" : "var(--color-border, #d1d5db)"}`,
                    borderRadius: "6px",
                    cursor: "pointer",
                    background: themeMode === "brief" ? "rgba(59,130,246,0.04)" : "transparent",
                  }}>
                    <input
                      type="radio"
                      name="themeMode"
                      value="brief"
                      checked={themeMode === "brief"}
                      onChange={() => setThemeMode("brief")}
                      style={{ marginTop: "2px" }}
                    />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>Describe my brand</div>
                      <div style={{ fontSize: "0.8rem", color: "var(--color-text-secondary)", marginTop: "0.2rem" }}>
                        Describe your brand colors and style and AI will generate a theme.
                      </div>
                      {themeMode === "brief" && (
                        <textarea
                          value={themeBrief}
                          onChange={(e) => setThemeBrief(e.target.value)}
                          placeholder="e.g. Modern SaaS, navy and white, Inter font, clean and minimal"
                          rows={3}
                          style={{
                            marginTop: "0.625rem",
                            width: "100%",
                            padding: "0.5rem 0.75rem",
                            fontSize: "0.85rem",
                            border: "1px solid var(--color-border, #d1d5db)",
                            borderRadius: "4px",
                            resize: "vertical",
                            boxSizing: "border-box",
                          }}
                        />
                      )}
                    </div>
                  </label>
                </div>
                <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
                  <button type="button" className="btn" onClick={closeImportModal}>Cancel</button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => setImportStep("upload")}
                    disabled={themeMode === "brief" && !themeBrief.trim()}
                  >
                    Continue
                  </button>
                </div>
              </div>
            )}

            {/* Step: upload */}
            {importStep === "upload" && (
              <>
                {/* Optional title */}
                <label style={{ display: "block", marginBottom: "1rem" }}>
                  <span style={{ fontSize: "0.85rem", fontWeight: 600, display: "block", marginBottom: "0.25rem" }}>
                    Page Title <span style={{ fontWeight: 400, color: "var(--color-text-muted, #6b7280)" }}>(optional)</span>
                  </span>
                  <input
                    type="text"
                    value={importTitle}
                    onChange={(e) => setImportTitle(e.target.value)}
                    placeholder="Auto-detect from HTML"
                    disabled={importing}
                    style={{
                      width: "100%",
                      padding: "0.5rem 0.75rem",
                      fontSize: "0.9rem",
                      border: "1px solid var(--color-border, #d1d5db)",
                      borderRadius: "4px",
                      boxSizing: "border-box",
                    }}
                  />
                </label>

                {/* Drop zone */}
                <div
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={handleFileDrop}
                  onClick={() => !importing && fileInputRef.current?.click()}
                  style={{
                    border: `2px dashed ${dragOver ? "var(--color-primary, #3b82f6)" : "var(--color-border, #d1d5db)"}`,
                    borderRadius: "6px",
                    padding: "2rem 1rem",
                    textAlign: "center",
                    cursor: importing ? "default" : "pointer",
                    background: dragOver ? "rgba(59,130,246,0.05)" : "transparent",
                    transition: "border-color 0.15s, background 0.15s",
                    marginBottom: "1rem",
                    userSelect: "none",
                  }}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".html,.htm"
                    style={{ display: "none" }}
                    onChange={handleFileChange}
                    disabled={importing}
                  />
                  {importFile ? (
                    <div>
                      <div style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>📄</div>
                      <div style={{ fontWeight: 600, wordBreak: "break-all" }}>{importFile.name}</div>
                      <div style={{ fontSize: "0.8rem", color: "var(--color-text-muted, #6b7280)", marginTop: "0.25rem" }}>
                        {(importFile.size / 1024).toFixed(1)} KB — click to change
                      </div>
                    </div>
                  ) : (
                    <div>
                      <div style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>⬆️</div>
                      <div style={{ fontWeight: 500 }}>Drop an HTML file here, or click to browse</div>
                      <div style={{ fontSize: "0.8rem", color: "var(--color-text-muted, #6b7280)", marginTop: "0.25rem" }}>
                        Accepts .html and .htm files
                      </div>
                    </div>
                  )}
                </div>

                {/* Loading state */}
                {importing && (
                  <div style={{
                    display: "flex", alignItems: "center", gap: "0.75rem",
                    padding: "0.75rem 1rem",
                    background: "rgba(59,130,246,0.08)",
                    borderRadius: "6px",
                    marginBottom: "1rem",
                    fontSize: "0.9rem",
                    color: "var(--color-text, #111)",
                  }}>
                    <span style={{
                      display: "inline-block", width: "16px", height: "16px",
                      border: "2px solid var(--color-primary, #3b82f6)",
                      borderTopColor: "transparent",
                      borderRadius: "50%",
                      animation: "spin 0.8s linear infinite",
                      flexShrink: 0,
                    }} />
                    <span>{needsTheme ? "Importing and setting up your theme…" : "Importing… downloading images and rewriting with your theme"}</span>
                  </div>
                )}

                {/* Error */}
                {importError && (
                  <div style={{
                    color: "#dc2626",
                    fontSize: "0.875rem",
                    marginBottom: "1rem",
                    padding: "0.5rem 0.75rem",
                    background: "#fef2f2",
                    borderRadius: "4px",
                    border: "1px solid #fecaca",
                  }}>
                    {importError}
                  </div>
                )}

                {/* Actions */}
                <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
                  {needsTheme && (
                    <button type="button" className="btn" onClick={() => setImportStep("theme")} disabled={importing}>
                      Back
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn"
                    onClick={closeImportModal}
                    disabled={importing}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={handleImport}
                    disabled={!importFile || importing}
                  >
                    {importing ? "Importing…" : "Import"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
