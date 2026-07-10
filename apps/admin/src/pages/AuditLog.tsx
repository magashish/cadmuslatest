import { useState, useEffect, useCallback } from "react";
import { auditLog, ai, type AuditEntry } from "../lib/api";
import { useAuth } from "../context/AuthContext";

const ACTION_LABELS: Record<string, string> = {
  "site.provisioned": "Site created",
  "site.updated": "Site updated",
  "site.activated": "Site activated",
  "site.billing_changed": "Billing updated",
  "site.domain_connected": "Domain connected",
  "site.domain_disconnected": "Domain disconnected",
  "site.subdomain_set": "Subdomain set",
  "site.subdomain_changed": "Subdomain changed",
  "content.created": "Content created",
  "content.imported": "Content imported",
  "content.imported_html": "HTML content imported",
  "content.imported_stitch_html": "Stitch HTML imported",
  "content.metadata_updated": "Content metadata updated",
  "content.updated": "Content updated",
  "content.archived": "Content archived",
  "content.version_restored": "Version restored",
  "favicon.generated": "Favicon generated",
  "media.uploaded": "Media uploaded",
  "media.deleted": "Media deleted",
  "media.generated": "Media generated",
  "footer.updated": "Footer updated",
  "header.updated": "Header updated",
  "theme.extract_fields": "Extracted editable fields",
  "navigation.updated": "Navigation updated",
  "collection.created": "Collection created",
  "collection.updated": "Collection updated",
  "collection.deleted": "Collection deleted",
  "content.unarchived": "Content restored",
  "media.updated": "Media updated",
  "redirect.created": "Redirect created",
  "redirect.imported": "Redirect(s) imported",
  "redirect.updated": "Redirect updated",
  "redirect.deleted": "Redirect deleted",
  "navigation.created": "Navigation created",
  "navigation.deleted": "Navigation deleted",
  "scheduled_task.created": "Task scheduled",
  "scheduled_task.cancelled": "Task cancelled",
  "billing.transferred": "Billing transferred",
  "billing.cancelled": "Subscription cancelled",
  "billing.reactivated": "Subscription reactivated",
  "billing.plan_changed": "Subscription updated",
  "account.password_changed": "Password changed",
  "account.password_reset": "Password reset",
  "account.profile_updated": "Profile updated",
  "site.restart_onboarding": "Onboarding restarted",
  "site.reset": "Site reset",
  "team.invited": "Member invited",
  "team.joined": "Member joined",
  "team.role_changed": "Role changed",
  "team.removed": "Member removed",
  "theme.recompile": "Recompiled theme CSS",
};

const ENTITY_TYPE_OPTIONS = ["content", "media", "site", "navigation", "user", "collection"];
const ACTOR_TYPE_OPTIONS = ["user", "ai", "cron", "addon"];
const AI_TASK_TYPE_OPTIONS = ["copywriting", "seo", "image", "interview", "analysis", "embedding", "alt-text", "visitor-chat"];
const AI_DECISION_OPTIONS = ["accepted", "rejected", "modified"];

type AITurn = {
  turnId: string;
  taskType: string;
  action: string;
  reply: string | null;
  model: string | null;
  usedFallback: boolean;
  createdAt: string;
  decision: "accepted" | "rejected" | "partial" | null;
  hasPendingActions: boolean;
  actions: Array<{
    id: string;
    actionType: string | null;
    entityType: string | null;
    entityId: string | null;
    suggestion: string | null;
    userDecision: string | null;
    decidedAt: string | null;
  }>;
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString();
}

function decisionBadgeStyle(decision: string) {
  if (decision === "accepted") return { bg: "#d1fae5", fg: "#065f46" };
  if (decision === "rejected") return { bg: "#fee2e2", fg: "#991b1b" };
  return { bg: "#fef3c7", fg: "#92400e" };
}

const SELECT_STYLE = { padding: "0.4rem 0.75rem", borderRadius: "6px", border: "1px solid #d1d5db", fontSize: "0.9rem" } as const;
const BADGE_BASE = { fontSize: "0.75rem", padding: "0.1rem 0.4rem", borderRadius: "4px" } as const;

export function AuditLog() {
  const { user } = useAuth();
  const [actorType, setActorType] = useState("");
  const [entityType, setEntityType] = useState("");
  const [aiTaskType, setAiTaskType] = useState("");
  const [aiDecision, setAiDecision] = useState("");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Audit log state
  const [entries, setEntries] = useState<AuditEntry[]>([]);

  // AI history state
  const [turns, setTurns] = useState<AITurn[]>([]);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [decideError, setDecideError] = useState<{ turnId: string; message: string } | null>(null);

  const isAI = actorType === "ai";

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      if (isAI) {
        const res = await ai.listHistory({
          page,
          limit: 30,
          taskType: aiTaskType || undefined,
          userDecision: aiDecision || undefined,
        });
        setTurns(res.turns);
        setTotalPages(res.pagination.totalPages);
        setTotal(res.pagination.total);
      } else {
        const res = await auditLog.list(user.siteId, {
          page,
          limit: 30,
          actorType: actorType || undefined,
          entityType: entityType || undefined,
        });
        setEntries(res.entries);
        setTotalPages(res.pagination.totalPages);
        setTotal(res.pagination.total);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [user, page, actorType, entityType, isAI, aiTaskType, aiDecision]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [actorType, entityType, aiTaskType, aiDecision]);

  const handleDecision = async (turnId: string, decision: "accepted" | "rejected") => {
    setDecidingId(turnId);
    setDecideError(null);
    try {
      await ai.decideTurn(turnId, decision);
      await load();
      if (decision === "rejected") window.dispatchEvent(new CustomEvent("cadmus:content-updated"));
    } catch (err) {
      setDecideError({ turnId, message: err instanceof Error ? err.message : "Decision failed" });
    } finally {
      setDecidingId(null);
    }
  };

  const totalLabel = isAI ? `${total} ${total === 1 ? "turn" : "turns"}` : `${total} entries`;

  return (
    <div className="page">
      <div className="page-header">
        <h2>Activity Log</h2>
        <span style={{ color: "#6b7280", fontSize: "0.9rem" }}>{totalLabel}</span>
      </div>

      <div style={{ display: "flex", gap: "0.75rem", marginBottom: "1rem", flexWrap: "wrap" }}>
        <select value={actorType} onChange={(e) => setActorType(e.target.value)} style={SELECT_STYLE}>
          <option value="">All actors</option>
          {ACTOR_TYPE_OPTIONS.map((t) => (
            <option key={t} value={t}>{t === "ai" ? "AI" : t.charAt(0).toUpperCase() + t.slice(1)}</option>
          ))}
        </select>

        {isAI ? (
          <>
            <select value={aiTaskType} onChange={(e) => setAiTaskType(e.target.value)} style={SELECT_STYLE}>
              <option value="">All task types</option>
              {AI_TASK_TYPE_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <select value={aiDecision} onChange={(e) => setAiDecision(e.target.value)} style={SELECT_STYLE}>
              <option value="">All decisions</option>
              {AI_DECISION_OPTIONS.map((t) => (
                <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
              ))}
            </select>
          </>
        ) : (
          <select value={entityType} onChange={(e) => setEntityType(e.target.value)} style={SELECT_STYLE}>
            <option value="">All entities</option>
            {ENTITY_TYPE_OPTIONS.map((t) => (
              <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
            ))}
          </select>
        )}
      </div>

      {loading ? (
        <p>Loading...</p>
      ) : isAI ? (
        turns.length === 0 ? (
          <p style={{ color: "#6b7280" }}>No AI activity found.</p>
        ) : (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: "1px", background: "#f3f4f6", borderRadius: "8px", overflow: "hidden" }}>
              {turns.map((turn) => {
                const isExpanded = expandedId === turn.turnId;
                const hasDetail = Boolean(turn.reply) || turn.actions.length > 0;
                const decisionColors = turn.decision ? decisionBadgeStyle(turn.decision) : null;
                return (
                  <div
                    key={turn.turnId}
                    style={{ background: "#fff", padding: "0.75rem 1rem", cursor: hasDetail ? "pointer" : "default" }}
                    onClick={() => hasDetail && setExpandedId(isExpanded ? null : turn.turnId)}
                  >
                    <div className="audit-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flex: 1, minWidth: 0 }}>
                        <span style={{ display: "inline-block", width: "6px", height: "6px", borderRadius: "50%", background: "#8b5cf6", flexShrink: 0 }} />
                        <span style={{ fontWeight: 500, fontSize: "0.9rem" }}>{turn.action}</span>
                        <span style={{ ...BADGE_BASE, background: "#ede9fe", color: "#6d28d9" }}>{turn.taskType}</span>
                        {turn.actions.length > 0 && (
                          <span style={{ ...BADGE_BASE, background: "#e0e7ff", color: "#3730a3" }}>
                            {turn.actions.length} action{turn.actions.length === 1 ? "" : "s"}
                          </span>
                        )}
                        {turn.decision && decisionColors && (
                          <span style={{ ...BADGE_BASE, background: decisionColors.bg, color: decisionColors.fg }}>{turn.decision}</span>
                        )}
                      </div>
                      <div className="audit-row__right" style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexShrink: 0 }}>
                        {turn.hasPendingActions && (
                          <div style={{ display: "flex", gap: "0.35rem" }} onClick={(e) => e.stopPropagation()}>
                            <button className="btn btn-small" disabled={decidingId === turn.turnId} onClick={() => handleDecision(turn.turnId, "accepted")}>Keep</button>
                            <button className="btn btn-small btn-ghost" disabled={decidingId === turn.turnId} onClick={() => handleDecision(turn.turnId, "rejected")}>
                              {decidingId === turn.turnId ? "Undoing..." : "Undo"}
                            </button>
                          </div>
                        )}
                        {turn.model && <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>{turn.model}</span>}
                        {turn.usedFallback && <span style={{ ...BADGE_BASE, background: "#fef3c7", color: "#92400e" }}>fallback</span>}
                        <span style={{ color: "#9ca3af", fontSize: "0.85rem", whiteSpace: "nowrap" }}>{formatDate(turn.createdAt)}</span>
                        {hasDetail && <span style={{ color: "#9ca3af", fontSize: "0.75rem" }}>{isExpanded ? "▲" : "▼"}</span>}
                      </div>
                    </div>
                    {isExpanded && (
                      <div style={{ marginTop: "0.5rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                        {turn.reply && (
                          <pre style={{ margin: 0, padding: "0.5rem 0.75rem", background: "#f9fafb", borderRadius: "4px", fontSize: "0.8rem", overflow: "auto", maxHeight: "300px", color: "#374151", whiteSpace: "pre-wrap" }}>
                            {turn.reply}
                          </pre>
                        )}
                        {turn.actions.map((action) => {
                          const ac = action.userDecision ? decisionBadgeStyle(action.userDecision) : null;
                          return (
                            <div key={action.id} style={{ padding: "0.4rem 0.75rem", background: "#f9fafb", borderRadius: "4px", fontSize: "0.8rem", color: "#374151", display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                              <code style={{ fontWeight: 600 }}>{action.actionType}</code>
                              {action.entityType && action.entityId && <span style={{ color: "#6b7280" }}>on {action.entityType}:{action.entityId.slice(0, 8)}</span>}
                              {action.userDecision && ac && <span style={{ ...BADGE_BASE, background: ac.bg, color: ac.fg }}>{action.userDecision}</span>}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {decideError?.turnId === turn.turnId && (
                      <div style={{ marginTop: "0.5rem", padding: "0.4rem 0.6rem", background: "#fef2f2", color: "#991b1b", fontSize: "0.8rem", borderRadius: "4px" }}>
                        {decideError.message}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <Pagination page={page} totalPages={totalPages} setPage={setPage} />
          </>
        )
      ) : (
        entries.length === 0 ? (
          <p style={{ color: "#6b7280" }}>No activity found.</p>
        ) : (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: "1px", background: "#f3f4f6", borderRadius: "8px", overflow: "hidden" }}>
              {entries.map((entry) => {
                const isExpanded = expandedId === entry.id;
                const details = entry.details && Object.keys(entry.details).length > 0 ? entry.details : null;
                return (
                  <div
                    key={entry.id}
                    style={{ background: "#fff", padding: "0.75rem 1rem", cursor: details ? "pointer" : "default" }}
                    onClick={() => details && setExpandedId(isExpanded ? null : entry.id)}
                  >
                    <div className="audit-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flex: 1, minWidth: 0 }}>
                        <span style={{ display: "inline-block", width: "6px", height: "6px", borderRadius: "50%", background: entry.actorType === "ai" ? "#8b5cf6" : entry.actorType === "cron" ? "#f59e0b" : "#3b82f6", flexShrink: 0 }} />
                        <span style={{ fontWeight: 500, fontSize: "0.9rem" }}>{ACTION_LABELS[entry.action] || entry.action}</span>
                        <span style={{ color: "#6b7280", fontSize: "0.85rem" }}>by {entry.actorName}</span>
                      </div>
                      <div className="audit-row__right" style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexShrink: 0 }}>
                        {entry.entityType && (
                          <span style={{ ...BADGE_BASE, background: "#f3f4f6", color: "#6b7280" }}>{entry.entityType}</span>
                        )}
                        <span style={{ color: "#9ca3af", fontSize: "0.85rem", whiteSpace: "nowrap" }}>{formatDate(entry.createdAt)}</span>
                        {details && <span style={{ color: "#9ca3af", fontSize: "0.75rem" }}>{isExpanded ? "▲" : "▼"}</span>}
                      </div>
                    </div>
                    {isExpanded && details && (
                      <pre style={{ marginTop: "0.5rem", padding: "0.5rem 0.75rem", background: "#f9fafb", borderRadius: "4px", fontSize: "0.8rem", overflow: "auto", maxHeight: "200px", color: "#374151" }}>
                        {JSON.stringify(details, null, 2)}
                      </pre>
                    )}
                  </div>
                );
              })}
            </div>
            <Pagination page={page} totalPages={totalPages} setPage={setPage} />
          </>
        )
      )}
    </div>
  );
}

function Pagination({ page, totalPages, setPage }: { page: number; totalPages: number; setPage: (fn: (p: number) => number) => void }) {
  if (totalPages <= 1) return null;
  return (
    <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: "1rem", marginTop: "1rem" }}>
      <button className="btn" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</button>
      <span style={{ color: "#6b7280", fontSize: "0.9rem" }}>Page {page} of {totalPages}</span>
      <button className="btn" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</button>
    </div>
  );
}
