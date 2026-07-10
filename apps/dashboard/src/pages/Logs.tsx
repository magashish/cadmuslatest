import { useEffect, useRef, useState } from "react";
import { admin, type LogEntryItem } from "../lib/api";

// Matches the actual Cloud Run services (and the API's allowlist). The
// admin/dashboard SPAs are static assets served via the worker — no Cloud Run
// service, no logs to show.
const SERVICES = [
  "cadmus-api",
  "cadmus-api-dev",
  "cadmus-web",
  "cadmus-web-dev",
  "cadmus-scanner",
  "cadmus-scanner-dev",
];

const SEVERITIES: { value: string; label: string }[] = [
  { value: "", label: "All" },
  { value: "INFO", label: "Info+" },
  { value: "WARNING", label: "Warning+" },
  { value: "ERROR", label: "Error+" },
];

const TIME_RANGES: { value: number; label: string }[] = [
  { value: 15, label: "15m" },
  { value: 60, label: "1h" },
  { value: 360, label: "6h" },
  { value: 1440, label: "24h" },
];

type State =
  | { status: "loading" }
  | { status: "ok"; entries: LogEntryItem[]; nextCursor?: string }
  | { status: "error"; message: string };

// Map a Cloud Logging severity to one of the dashboard's existing status-badge
// color classes. ERROR/CRITICAL → red-ish, WARNING → yellow-ish, else neutral.
function severityClass(severity: string): string {
  const s = severity.toUpperCase();
  if (s === "ERROR" || s === "CRITICAL" || s === "ALERT" || s === "EMERGENCY") {
    return "status-past_due"; // amber/red-ish existing palette (no red badge exists; use strongest)
  }
  if (s === "WARNING") return "status-draft"; // yellow-ish
  return "status-canceled"; // neutral grey
}

function severityStyle(severity: string): React.CSSProperties {
  const s = severity.toUpperCase();
  if (s === "ERROR" || s === "CRITICAL" || s === "ALERT" || s === "EMERGENCY") {
    return { background: "#fee2e2", color: "#991b1b" };
  }
  if (s === "WARNING") return { background: "#fef3c7", color: "#92400e" };
  return {};
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function Logs() {
  const [service, setService] = useState(SERVICES[0]);
  const [severity, setSeverity] = useState("");
  const [sinceMinutes, setSinceMinutes] = useState(60);
  const [search, setSearch] = useState("");
  // Debounced copy of `search` — the value actually sent to the API.
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [state, setState] = useState<State>({ status: "loading" });
  const [loadingMore, setLoadingMore] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // Debounce the free-text search so keystrokes don't fire a query each.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 400);
    return () => clearTimeout(t);
  }, [search]);

  // Track the latest request so a slow earlier response can't overwrite a
  // newer one.
  const reqIdRef = useRef(0);

  function load() {
    const reqId = ++reqIdRef.current;
    setState({ status: "loading" });
    setLoadingMore(false);
    setExpanded(new Set());
    admin
      .logs({
        service,
        severity: severity || undefined,
        q: debouncedSearch || undefined,
        sinceMinutes,
        limit: 100,
      })
      .then(({ entries, nextCursor }) => {
        if (reqId === reqIdRef.current) setState({ status: "ok", entries, nextCursor });
      })
      .catch((err: Error) => {
        if (reqId === reqIdRef.current) setState({ status: "error", message: err.message });
      });
  }

  function loadMore() {
    if (state.status !== "ok" || !state.nextCursor || loadingMore) return;
    const reqId = reqIdRef.current;
    const prev = state;
    setLoadingMore(true);
    admin
      .logs({
        service,
        severity: severity || undefined,
        q: debouncedSearch || undefined,
        sinceMinutes,
        limit: 100,
        cursor: prev.nextCursor,
      })
      .then(({ entries, nextCursor }) => {
        // Drop the result if a filter change reloaded the list in the meantime.
        if (reqId !== reqIdRef.current) return;
        setState({ status: "ok", entries: [...prev.entries, ...entries], nextCursor });
      })
      .catch((err: Error) => {
        if (reqId === reqIdRef.current) setState({ status: "error", message: err.message });
      })
      .finally(() => setLoadingMore(false));
  }

  // Auto-load whenever a filter (or the debounced search) changes.
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service, severity, sinceMinutes, debouncedSearch]);

  function toggleRow(i: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  return (
    <div className="page">
      <h2>API Logs</h2>
      <p style={{ color: "var(--color-text-muted)", marginTop: "-0.5rem" }}>
        Cloud Run service logs. Staff only.
      </p>

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "0.75rem",
          alignItems: "center",
          margin: "1rem 0",
        }}
      >
        <label style={{ display: "flex", flexDirection: "column", fontSize: "0.75em", color: "var(--color-text-muted)" }}>
          Service
          <select value={service} onChange={(e) => setService(e.target.value)}>
            {SERVICES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>

        <label style={{ display: "flex", flexDirection: "column", fontSize: "0.75em", color: "var(--color-text-muted)" }}>
          Severity
          <select value={severity} onChange={(e) => setSeverity(e.target.value)}>
            {SEVERITIES.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </label>

        <label style={{ display: "flex", flexDirection: "column", fontSize: "0.75em", color: "var(--color-text-muted)" }}>
          Range
          <select value={sinceMinutes} onChange={(e) => setSinceMinutes(Number(e.target.value))}>
            {TIME_RANGES.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
        </label>

        <label style={{ display: "flex", flexDirection: "column", fontSize: "0.75em", color: "var(--color-text-muted)", flex: "1 1 240px" }}>
          Search
          <input
            type="text"
            value={search}
            maxLength={200}
            placeholder="Free-text search…"
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>

        <button
          className="btn btn-sm"
          style={{ alignSelf: "flex-end" }}
          onClick={load}
          disabled={state.status === "loading"}
        >
          {state.status === "loading" ? "Loading…" : "Refresh"}
        </button>
      </div>

      {state.status === "loading" ? (
        <div className="card" style={{ padding: "1rem", color: "var(--color-text-muted)" }}>
          Loading logs…
        </div>
      ) : state.status === "error" ? (
        <div className="card" style={{ padding: "1rem", color: "var(--color-danger, #c33)" }}>
          {state.message}
        </div>
      ) : state.entries.length === 0 ? (
        <div className="card" style={{ padding: "1rem", color: "var(--color-text-muted)" }}>
          No log entries match these filters in the selected time range.
        </div>
      ) : (
        <table className="content-table">
          <thead>
            <tr>
              <th style={{ width: "11rem" }}>Time</th>
              <th style={{ width: "6rem" }}>Severity</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody>
            {state.entries.map((entry, i) => {
              const isOpen = expanded.has(i);
              const req = entry.httpRequest;
              const hasReqDetail = Boolean(req && (req.requestUrl || req.remoteIp || req.userAgent));
              // Expandable when there's request detail to reveal, or when the
              // message is long/multi-line enough that wrapping helps.
              const expandable =
                hasReqDetail || entry.message.length > 120 || entry.message.includes("\n");
              return (
                <tr
                  key={i}
                  onClick={expandable ? () => toggleRow(i) : undefined}
                  style={expandable ? { cursor: "pointer" } : undefined}
                >
                  <td style={{ fontSize: "0.8em", color: "var(--color-text-muted)", whiteSpace: "nowrap" }}>
                    {fmtTime(entry.timestamp)}
                  </td>
                  <td>
                    <span
                      className={`status-badge ${severityClass(entry.severity)}`}
                      style={severityStyle(entry.severity)}
                    >
                      {entry.severity}
                    </span>
                  </td>
                  <td
                    style={{
                      fontFamily: "monospace",
                      fontSize: "0.82em",
                      whiteSpace: isOpen ? "pre-wrap" : "nowrap",
                      overflow: isOpen ? "visible" : "hidden",
                      textOverflow: "ellipsis",
                      maxWidth: 0,
                      wordBreak: "break-word",
                    }}
                    title={expandable && !isOpen ? "Click to expand" : undefined}
                  >
                    {entry.message || (
                      <span style={{ color: "var(--color-text-muted)", fontStyle: "italic" }}>(no message)</span>
                    )}
                    {isOpen && hasReqDetail && req && (
                      <div style={{ marginTop: "0.4rem", color: "var(--color-text-muted)", fontSize: "0.95em" }}>
                        {req.requestUrl && <div>url: {req.requestUrl}</div>}
                        {req.remoteIp && <div>ip: {req.remoteIp}</div>}
                        {req.userAgent && <div>ua: {req.userAgent}</div>}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {state.status === "ok" && state.nextCursor && (
        <div style={{ textAlign: "center", margin: "1rem 0" }}>
          <button className="btn btn-sm" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}
