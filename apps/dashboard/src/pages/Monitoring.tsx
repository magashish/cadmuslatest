import { useEffect, useRef, useState } from "react";
import { admin, sentryApi, type SentryAlertsResponse } from "../lib/api";

// ── AI Usage ─────────────────────────────────────────────────────────────────

interface AiUsageRow {
  siteId: string;
  siteName: string;
  subdomain: string;
  chatMessages30d: number;
  imagesMonthly: number;
  pagesLifetime: number;
}

interface AiUsageTotals {
  chatMessages30d: number;
  imagesMonthly: number;
  pagesLifetime: number;
}

type AiUsageState =
  | { status: "loading" }
  | { status: "ok"; items: AiUsageRow[]; totals: AiUsageTotals }
  | { status: "error"; message: string };

function AiUsageSection() {
  const [state, setState] = useState<AiUsageState>({ status: "loading" });

  useEffect(() => {
    admin
      .aiUsage()
      .then(({ items, totals }) => setState({ status: "ok", items, totals }))
      .catch((err: Error) => setState({ status: "error", message: err.message }));
  }, []);

  if (state.status === "loading") {
    return <div className="card" style={{ padding: "1rem", color: "var(--color-text-muted)" }}>Loading…</div>;
  }
  if (state.status === "error") {
    return <div className="card" style={{ padding: "1rem", color: "var(--color-danger, #c33)" }}>{state.message}</div>;
  }

  const { items, totals } = state;

  if (items.length === 0) {
    return <div className="card" style={{ padding: "1rem", color: "var(--color-text-muted)" }}>No AI usage recorded yet.</div>;
  }

  return (
    <table className="content-table">
      <thead>
        <tr>
          <th>Site</th>
          <th style={{ textAlign: "right" }}>Chat (30d)</th>
          <th style={{ textAlign: "right" }}>Images (month)</th>
          <th style={{ textAlign: "right" }}>Pages (lifetime)</th>
        </tr>
      </thead>
      <tbody>
        {items.map((row) => (
          <tr key={row.siteId}>
            <td>
              <span style={{ fontWeight: 500 }}>{row.siteName}</span>
              <span style={{ marginLeft: "0.4rem", fontSize: "0.8em", color: "var(--color-text-muted)" }}>
                {row.subdomain}
              </span>
            </td>
            <td style={{ textAlign: "right" }}>{row.chatMessages30d.toLocaleString()}</td>
            <td style={{ textAlign: "right" }}>{row.imagesMonthly.toLocaleString()}</td>
            <td style={{ textAlign: "right" }}>{row.pagesLifetime.toLocaleString()}</td>
          </tr>
        ))}
        <tr style={{ fontWeight: 700, borderTop: "2px solid var(--color-border, #e5e7eb)" }}>
          <td>Platform total</td>
          <td style={{ textAlign: "right" }}>{totals.chatMessages30d.toLocaleString()}</td>
          <td style={{ textAlign: "right" }}>{totals.imagesMonthly.toLocaleString()}</td>
          <td style={{ textAlign: "right" }}>{totals.pagesLifetime.toLocaleString()}</td>
        </tr>
      </tbody>
    </table>
  );
}

type SentryState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; data: SentryAlertsResponse }
  | { status: "error"; message: string };

function levelColor(level: string): string {
  if (level === "fatal" || level === "error") return "var(--color-danger, #c33)";
  if (level === "warning") return "#b45309";
  return "var(--color-text-muted)";
}

function SentryAlerts() {
  const [state, setState] = useState<SentryState>({ status: "idle" });
  const [now, setNow] = useState(() => Date.now());
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function load() {
    setState({ status: "loading" });
    sentryApi
      .issues()
      .then((data) => setState({ status: "ok", data }))
      .catch((err: Error) => setState({ status: "error", message: err.message }));
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    tickRef.current = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      if (tickRef.current !== null) clearInterval(tickRef.current);
    };
  }, []);

  const canRefresh =
    state.status !== "loading" &&
    (state.status !== "ok" || now >= new Date(state.data.nextRefreshAt).getTime());

  function countdownLabel(): string | null {
    if (state.status !== "ok") return null;
    const msLeft = new Date(state.data.nextRefreshAt).getTime() - now;
    if (msLeft <= 0) return null;
    const secs = Math.ceil(msLeft / 1000);
    return `${secs}s`;
  }

  const countdown = countdownLabel();

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.75rem" }}>
        <button
          className="btn btn-sm"
          onClick={load}
          disabled={!canRefresh}
        >
          {state.status === "loading"
            ? "Loading…"
            : countdown
            ? `Refresh (${countdown})`
            : "Refresh"}
        </button>
        {state.status === "ok" && (
          <span style={{
            fontSize: "0.75em",
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            padding: "0.2em 0.6em",
            borderRadius: "999px",
            background: state.data.environment === "production" ? "#fef2f2" : "#eff6ff",
            color: state.data.environment === "production" ? "#b91c1c" : "#1d4ed8",
            border: `1px solid ${state.data.environment === "production" ? "#fecaca" : "#bfdbfe"}`,
          }}>
            {state.data.environment}
          </span>
        )}
      </div>

      {state.status === "idle" || state.status === "loading" ? (
        <div className="card" style={{ padding: "1rem", color: "var(--color-text-muted)" }}>
          Loading Sentry issues…
        </div>
      ) : state.status === "error" ? (
        <div className="card" style={{ padding: "1rem", color: "var(--color-danger, #c33)" }}>
          {state.message}
        </div>
      ) : state.data.issues.length === 0 ? (
        <div className="card" style={{ padding: "1rem", color: "var(--color-text-muted)" }}>
          No unresolved issues in the last 24 hours.
        </div>
      ) : (
        <table className="content-table">
          <thead>
            <tr>
              <th>Project</th>
              <th>Level</th>
              <th>Error</th>
              <th>Count</th>
              <th>Last Seen</th>
            </tr>
          </thead>
          <tbody>
            {state.data.issues.map((issue) => (
              <tr key={issue.id}>
                <td style={{ fontFamily: "monospace", fontSize: "0.9em" }}>{issue.project}</td>
                <td style={{ color: levelColor(issue.level), fontWeight: 600, textTransform: "capitalize" }}>
                  {issue.level}
                </td>
                <td>
                  <a href={issue.permalink} target="_blank" rel="noopener noreferrer">
                    {issue.title}
                  </a>
                </td>
                <td>{issue.count.toLocaleString()}</td>
                <td style={{ fontSize: "0.85em", color: "var(--color-text-muted)" }}>
                  {new Date(issue.lastSeen).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {state.status === "ok" && (
        <div style={{ marginTop: "0.5rem", fontSize: "0.8em", color: "var(--color-text-muted)" }}>
          Cached at {new Date(state.data.cachedAt).toLocaleString()} &middot; refreshes available after{" "}
          {new Date(state.data.nextRefreshAt).toLocaleString()}
        </div>
      )}
    </div>
  );
}

export function Monitoring() {
  return (
    <div className="page">
      <h2>Monitoring</h2>

      <section style={{ marginTop: "1.5rem" }}>
        <h3>Sentry Alerts</h3>
        <SentryAlerts />
      </section>

      <section style={{ marginTop: "2rem" }}>
        <h3>GCP Usage &amp; Alerts</h3>
        <div className="card" style={{ padding: "1rem", color: "var(--color-text-muted)" }}>
          Coming soon — Cloud Run instance counts, Cloud SQL CPU/memory, storage egress, billing alerts.
        </div>
      </section>

      <section style={{ marginTop: "2rem" }}>
        <h3>AI Usage</h3>
        <AiUsageSection />
      </section>
    </div>
  );
}
