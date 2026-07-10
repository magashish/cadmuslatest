import { useEffect, useState } from "react";
import { admin } from "../lib/api";

interface ConfigRow {
  key: string;
  value: unknown;
  description: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

type RowState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved" }
  | { status: "error"; message: string };

export function PlatformConfig() {
  const [rows, setRows] = useState<ConfigRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({});

  useEffect(() => {
    admin
      .platformConfig()
      .then((res) => {
        setRows(res.items);
        const initial: Record<string, string> = {};
        for (const row of res.items) {
          initial[row.key] = String(row.value);
        }
        setDrafts(initial);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  function handleDraftChange(key: string, raw: string) {
    setDrafts((prev) => ({ ...prev, [key]: raw }));
    setRowStates((prev) => ({ ...prev, [key]: { status: "idle" } }));
  }

  async function handleSave(row: ConfigRow) {
    const raw = drafts[row.key] ?? String(row.value);
    // Parse: try number, then bool, then string
    let parsed: unknown = raw;
    if (raw === "true") parsed = true;
    else if (raw === "false") parsed = false;
    else if (!isNaN(Number(raw)) && raw.trim() !== "") parsed = Number(raw);

    setRowStates((prev) => ({ ...prev, [row.key]: { status: "saving" } }));
    try {
      const res = await admin.setPlatformConfig(row.key, parsed);
      setRows((prev) =>
        prev.map((r) => (r.key === row.key ? res.item : r))
      );
      setRowStates((prev) => ({ ...prev, [row.key]: { status: "saved" } }));
      setTimeout(() => {
        setRowStates((prev) => {
          const cur = prev[row.key];
          return cur?.status === "saved" ? { ...prev, [row.key]: { status: "idle" } } : prev;
        });
      }, 2500);
    } catch (err) {
      setRowStates((prev) => ({
        ...prev,
        [row.key]: { status: "error", message: err instanceof Error ? err.message : "Save failed" },
      }));
    }
  }

  const formatDate = (d: string) =>
    new Date(d).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });

  if (loading) {
    return (
      <div className="page">
        <p>Loading...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="page">
        <p style={{ color: "var(--color-danger, #c0392b)" }}>Error: {error}</p>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <h2>Platform Config</h2>
      </div>
      <p style={{ color: "var(--color-text-muted)", marginBottom: "1.5rem" }}>
        Global platform settings. Changes take effect immediately.
      </p>
      <table className="content-table">
        <thead>
          <tr>
            <th>Key</th>
            <th>Description</th>
            <th style={{ width: "180px" }}>Value</th>
            <th>Last Updated</th>
            <th style={{ width: "80px" }}></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const state: RowState = rowStates[row.key] ?? { status: "idle" };
            const draft = drafts[row.key] ?? String(row.value);
            return (
              <tr key={row.key}>
                <td>
                  <code style={{ fontSize: "0.8rem" }}>{row.key}</code>
                </td>
                <td style={{ color: "var(--color-text-muted)", fontSize: "0.875rem" }}>
                  {row.description ?? "--"}
                </td>
                <td>
                  <input
                    type="text"
                    value={draft}
                    onChange={(e) => handleDraftChange(row.key, e.target.value)}
                    disabled={state.status === "saving"}
                    style={{ width: "100%", padding: "0.25rem 0.5rem", fontSize: "0.875rem" }}
                  />
                  {state.status === "error" && (
                    <p style={{ color: "var(--color-danger, #c0392b)", fontSize: "0.75rem", margin: "0.25rem 0 0" }}>
                      {state.message}
                    </p>
                  )}
                  {state.status === "saved" && (
                    <p style={{ color: "#16a34a", fontSize: "0.75rem", margin: "0.25rem 0 0" }}>
                      Saved
                    </p>
                  )}
                </td>
                <td style={{ color: "var(--color-text-muted)", fontSize: "0.8rem", whiteSpace: "nowrap" }}>
                  {formatDate(row.updatedAt)}
                  {row.updatedBy && (
                    <span style={{ display: "block", fontSize: "0.7rem", marginTop: "0.125rem" }}>
                      by {row.updatedBy.slice(0, 8)}…
                    </span>
                  )}
                </td>
                <td>
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => handleSave(row)}
                    disabled={state.status === "saving" || draft === String(row.value)}
                  >
                    {state.status === "saving" ? "…" : "Save"}
                  </button>
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} style={{ textAlign: "center", color: "var(--color-text-muted)" }}>
                No config rows found.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
