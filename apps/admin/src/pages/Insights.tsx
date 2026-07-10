import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { ai, type Insight } from "../lib/api";
import { useAuth } from "../context/AuthContext";

const PAGE_LABELS: Record<string, string> = {
  "/": "Dashboard",
  "/content": "Content",
  "/collections": "Collections",
  "/theme": "Style",
  "/seo": "SEO",
  "/addons": "Add-ons",
  "/media": "Media",
  "/forms": "Forms",
  "/settings": "Settings",
  "/team": "Team",
  "/account": "Account",
};

function pageLabel(path: string | null): string | null {
  if (!path) return null;
  if (PAGE_LABELS[path]) return PAGE_LABELS[path];
  // Fall back to a humanized last segment, e.g. "/content/abc" -> "Content"
  const head = "/" + path.split("/").filter(Boolean)[0];
  return PAGE_LABELS[head] ?? path;
}

function dismissStorageKey(siteId: string): string {
  return `cadmus:dismissed-insights:${siteId}`;
}

function loadDismissed(siteId: string): Set<string> {
  try {
    const raw = localStorage.getItem(dismissStorageKey(siteId));
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

function saveDismissed(siteId: string, ids: Set<string>) {
  try {
    localStorage.setItem(dismissStorageKey(siteId), JSON.stringify(Array.from(ids)));
  } catch {
    // ignore quota / privacy-mode errors
  }
}

export function Insights() {
  const { user } = useAuth();
  const [insights, setInsights] = useState<Insight[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [dismissed, setDismissed] = useState<Set<string>>(() =>
    user?.siteId ? loadDismissed(user.siteId) : new Set(),
  );
  const [showDismissed, setShowDismissed] = useState(false);

  const siteId = user?.siteId;

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await ai.insights();
      setInsights(res.insights);
    } catch {
      setError("Couldn't load insights. Try again in a moment.");
      setInsights([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (siteId) setDismissed(loadDismissed(siteId));
  }, [siteId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleDismiss = (id: string) => {
    if (!siteId) return;
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(id);
      saveDismissed(siteId, next);
      return next;
    });
  };

  const handleRestore = (id: string) => {
    if (!siteId) return;
    setDismissed((prev) => {
      const next = new Set(prev);
      next.delete(id);
      saveDismissed(siteId, next);
      return next;
    });
  };

  const active = insights.filter((i) => !dismissed.has(i.id));
  const hidden = insights.filter((i) => dismissed.has(i.id));

  return (
    <div className="page">
      <div className="page-header">
        <h2>Insights</h2>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <span style={{ color: "var(--color-text-muted)", fontSize: "0.9rem" }}>
            {active.length} open{hidden.length > 0 ? ` · ${hidden.length} dismissed` : ""}
          </span>
          <button type="button" className="btn btn-small" onClick={load} disabled={loading}>
            {loading ? "Scanning…" : "Re-scan"}
          </button>
        </div>
      </div>

      <p style={{ color: "var(--color-text-muted)", marginBottom: "1.5rem", maxWidth: "60ch" }}>
        Things on your site that look incomplete, broken, or worth a second look. Open the page
        to fix it directly, or use the AI assistant there to help.
      </p>

      {error && (
        <div className="card" style={{ borderColor: "#fecaca", background: "#fef2f2", marginBottom: "1rem" }}>
          <p style={{ color: "#991b1b", margin: 0 }}>{error}</p>
        </div>
      )}

      {!loading && active.length === 0 && !error && (
        <div className="card">
          <h3>Nothing to address right now</h3>
          <p>
            No open insights. We&apos;ll surface anything new the next time you re-scan or visit
            a page that has a fixable issue.
          </p>
        </div>
      )}

      {active.length > 0 && (
        <div>
          {active.map((insight) => (
            <InsightCard
              key={insight.id}
              insight={insight}
              onDismiss={() => handleDismiss(insight.id)}
            />
          ))}
        </div>
      )}

      {hidden.length > 0 && (
        <div style={{ marginTop: "2rem" }}>
          <button
            type="button"
            className="btn btn-small btn-ghost"
            onClick={() => setShowDismissed((v) => !v)}
          >
            {showDismissed ? "Hide" : "Show"} dismissed ({hidden.length})
          </button>
          {showDismissed && (
            <div style={{ marginTop: "0.75rem", opacity: 0.7 }}>
              {hidden.map((insight) => (
                <InsightCard
                  key={insight.id}
                  insight={insight}
                  dismissed
                  onRestore={() => handleRestore(insight.id)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface InsightCardProps {
  insight: Insight;
  dismissed?: boolean;
  onDismiss?: () => void;
  onRestore?: () => void;
}

function InsightCard({ insight, dismissed, onDismiss, onRestore }: InsightCardProps) {
  const label = pageLabel(insight.page);
  return (
    <div className="ai-suggestion-card" style={{ marginBottom: "0.75rem" }}>
      <div className="ai-suggestion-card__title">{insight.title}</div>
      <div className="ai-suggestion-card__rationale">{insight.rationale}</div>
      <div className="ai-suggestion-card__actions">
        {insight.page && label && (
          <Link to={insight.page} className="btn btn-small btn-primary">
            {insight.actionLabel ?? `Open ${label}`}
          </Link>
        )}
        {dismissed ? (
          <button type="button" className="btn btn-small btn-ghost" onClick={onRestore}>
            Restore
          </button>
        ) : (
          <button type="button" className="btn btn-small btn-ghost" onClick={onDismiss}>
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}
