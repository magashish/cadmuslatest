import { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { admin, type SiteListItem } from "../lib/api";

export function SitesList() {
  const [items, setItems] = useState<SiteListItem[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [cleanupState, setCleanupState] = useState<"idle" | "previewing" | "running" | "done">("idle");
  const [cleanupPreview, setCleanupPreview] = useState<{ siteId: string; name: string; subdomain: string }[]>([]);
  const [cleanupResult, setCleanupResult] = useState<{ deleted: number } | null>(null);
  const [cleanupError, setCleanupError] = useState("");

  const fetchSites = useCallback(async () => {
    setLoading(true);
    try {
      const res = await admin.sites({ page, limit: 25, search, status: statusFilter });
      setItems(res.items);
      setTotalPages(res.pagination.totalPages);
      setTotal(res.pagination.total);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [page, search, statusFilter]);

  useEffect(() => {
    fetchSites();
  }, [fetchSites]);

  const handleSearch = (value: string) => {
    setSearch(value);
    setPage(1);
  };

  const handleStatusChange = (value: string) => {
    setStatusFilter(value);
    setPage(1);
  };

  const formatDate = (d: string) =>
    new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  const handleCleanupPreview = async () => {
    setCleanupState("previewing");
    setCleanupError("");
    try {
      const res = await admin.expireArchivesDryRun();
      setCleanupPreview(res.previews ?? []);
      if (res.expired === 0) {
        setCleanupState("done");
        setCleanupResult({ deleted: 0 });
      }
    } catch (e) {
      setCleanupError(e instanceof Error ? e.message : "Failed");
      setCleanupState("idle");
    }
  };

  const handleCleanupConfirm = async () => {
    setCleanupState("running");
    setCleanupError("");
    try {
      const res = await admin.expireArchives();
      setCleanupResult({ deleted: res.deleted ?? res.results?.filter((r) => r.deleted).length ?? 0 });
      setCleanupState("done");
      fetchSites();
    } catch (e) {
      setCleanupError(e instanceof Error ? e.message : "Failed");
      setCleanupState("idle");
    }
  };

  return (
    <div className="page">
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: "1rem" }}>
        <h2>Sites ({total})</h2>
        <button className="btn btn-sm" onClick={handleCleanupPreview} disabled={cleanupState !== "idle" && cleanupState !== "done"}>
          {cleanupState === "previewing" ? "Checking…" : cleanupState === "running" ? "Deleting…" : "Clean up expired archives"}
        </button>
      </div>

      {cleanupState === "previewing" && cleanupPreview.length > 0 && (
        <div className="card" style={{ padding: "1rem", marginBottom: "1rem", background: "#fef2f2", border: "1px solid #fecaca" }}>
          <strong>Ready to permanently delete {cleanupPreview.length} site{cleanupPreview.length === 1 ? "" : "s"}:</strong>
          <ul style={{ margin: "0.5rem 0 0.75rem 1.25rem" }}>
            {cleanupPreview.map((s) => <li key={s.siteId}>{s.name} ({s.subdomain})</li>)}
          </ul>
          <button className="btn btn-danger" onClick={handleCleanupConfirm} style={{ marginRight: "0.5rem" }}>Confirm delete</button>
          <button className="btn" onClick={() => setCleanupState("idle")}>Cancel</button>
        </div>
      )}
      {cleanupState === "done" && cleanupResult && (
        <div className="card" style={{ padding: "0.75rem 1rem", marginBottom: "1rem", background: "#f0fdf4", border: "1px solid #bbf7d0" }}>
          {cleanupResult.deleted === 0 ? "No expired archives to clean up." : `✓ Permanently deleted ${cleanupResult.deleted} site${cleanupResult.deleted === 1 ? "" : "s"}.`}
          <button className="btn btn-sm" style={{ marginLeft: "1rem" }} onClick={() => { setCleanupState("idle"); setCleanupResult(null); }}>Dismiss</button>
        </div>
      )}
      {cleanupError && <p style={{ color: "var(--color-danger, #c33)", marginBottom: "1rem" }}>{cleanupError}</p>}

      <div className="filter-bar">
        <input
          type="text"
          placeholder="Search by name or subdomain..."
          value={search}
          onChange={(e) => handleSearch(e.target.value)}
        />
        <select value={statusFilter} onChange={(e) => handleStatusChange(e.target.value)}>
          <option value="">All statuses</option>
          <option value="onboarding">Onboarding</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
          <option value="archived">Archived</option>
        </select>
      </div>

      {loading ? (
        <p>Loading...</p>
      ) : items.length === 0 ? (
        <p style={{ color: "var(--color-text-muted)" }}>No sites found.</p>
      ) : (
        <>
          <table className="content-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Subdomain</th>
                <th>Custom Domain</th>
                <th>Status</th>
                <th>Plan</th>
                <th>Owner</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {items.map((site) => (
                <tr key={site.id}>
                  <td>
                    <Link to={`/sites/${site.id}`}>{site.name}</Link>
                  </td>
                  <td>{site.subdomain}</td>
                  <td>{site.domain || <span style={{ color: "var(--color-text-muted)" }}>--</span>}</td>
                  <td>
                    <span className={`status-badge status-${site.status}`}>{site.status}</span>
                  </td>
                  <td>
                    {site.subscriptionStatus ? (
                      <span className={`status-badge status-${site.subscriptionStatus}`}>
                        {site.subscriptionStatus}
                      </span>
                    ) : (
                      <span style={{ color: "var(--color-text-muted)" }}>--</span>
                    )}
                  </td>
                  <td>{site.ownerEmail || "--"}</td>
                  <td>{formatDate(site.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {totalPages > 1 && (
            <div className="pagination">
              <button onClick={() => setPage((p) => p - 1)} disabled={page <= 1}>
                Previous
              </button>
              <span className="pagination-info">
                Page {page} of {totalPages}
              </span>
              <button onClick={() => setPage((p) => p + 1)} disabled={page >= totalPages}>
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
