import { useState, useEffect } from "react";
import { support, type SupportTicket, type TicketComment } from "../lib/api";

type Tab = "tickets" | "settings";
type StatusFilter = "" | "open" | "in_progress" | "resolved" | "closed";
type TypeFilter = "" | "support" | "feature_request";

const STATUS_LABELS: Record<string, string> = {
  open: "Open",
  in_progress: "In Progress",
  resolved: "Resolved",
  closed: "Closed",
};

const STATUS_COLORS: Record<string, string> = {
  open: "#2563eb",
  in_progress: "#d97706",
  resolved: "#16a34a",
  closed: "#6b7280",
};

const PRIORITY_COLORS: Record<string, string> = {
  high: "#dc2626",
  normal: "#6b7280",
  low: "#9ca3af",
};

export function Support() {
  const [tab, setTab] = useState<Tab>("tickets");

  // Ticket list state
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [updating, setUpdating] = useState<string | null>(null);

  // Comment state
  const [comments, setComments] = useState<Record<string, TicketComment[]>>({});
  const [commentsLoading, setCommentsLoading] = useState<string | null>(null);
  const [commentBody, setCommentBody] = useState<Record<string, string>>({});
  const [commentInternal, setCommentInternal] = useState<Record<string, boolean>>({});
  const [commentSaving, setCommentSaving] = useState<string | null>(null);

  // Settings state
  const [notifEmails, setNotifEmails] = useState("");
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);

  const loadTickets = async () => {
    setLoading(true);
    setLoadError("");
    try {
      const res = await support.tickets({
        status: statusFilter || undefined,
        type: typeFilter || undefined,
        limit: 50,
      });
      setTickets(res.tickets);
      setTotal(res.total);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load tickets");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (tab === "tickets") loadTickets();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, statusFilter, typeFilter]);

  useEffect(() => {
    if (tab === "settings") {
      setSettingsLoading(true);
      support.getSettings()
        .then((res) => {
          setNotifEmails(res.settings.support_notification_emails ?? "");
        })
        .catch(() => {})
        .finally(() => setSettingsLoading(false));
    }
  }, [tab]);

  const handleStatusChange = async (ticketId: string, status: string) => {
    setUpdating(ticketId);
    try {
      const res = await support.update(ticketId, { status });
      setTickets((prev) => prev.map((t) => t.id === ticketId ? { ...t, ...res.ticket } : t));
    } catch {
      // ignore
    } finally {
      setUpdating(null);
    }
  };

  const handleExpand = async (ticketId: string) => {
    const isExpanding = expandedId !== ticketId;
    setExpandedId(isExpanding ? ticketId : null);
    if (isExpanding && !comments[ticketId]) {
      setCommentsLoading(ticketId);
      try {
        const res = await support.comments(ticketId);
        setComments((prev) => ({ ...prev, [ticketId]: res.comments }));
      } catch {
        setComments((prev) => ({ ...prev, [ticketId]: [] }));
      } finally {
        setCommentsLoading(null);
      }
    }
  };

  const handleAddComment = async (ticketId: string) => {
    const body = commentBody[ticketId]?.trim();
    if (!body) return;
    setCommentSaving(ticketId);
    try {
      const res = await support.addComment(ticketId, {
        body,
        isInternal: commentInternal[ticketId] ?? false,
      });
      setComments((prev) => ({ ...prev, [ticketId]: [...(prev[ticketId] || []), res.comment] }));
      setCommentBody((prev) => ({ ...prev, [ticketId]: "" }));
    } catch {
      // ignore
    } finally {
      setCommentSaving(null);
    }
  };

  const handlePriorityChange = async (ticketId: string, priority: string) => {
    setUpdating(ticketId);
    try {
      const res = await support.update(ticketId, { priority });
      setTickets((prev) => prev.map((t) => t.id === ticketId ? { ...t, ...res.ticket } : t));
    } catch {
      // ignore
    } finally {
      setUpdating(null);
    }
  };

  const handleSaveSettings = async () => {
    setSettingsSaving(true);
    setSettingsSaved(false);
    try {
      await support.saveSettings({ support_notification_emails: notifEmails });
      setSettingsSaved(true);
      setTimeout(() => setSettingsSaved(false), 3000);
    } catch {
      // ignore
    } finally {
      setSettingsSaving(false);
    }
  };

  const openCount = tickets.filter((t) => t.status === "open").length;

  return (
    <div className="page">
      <h2>Support</h2>

      <div style={{ display: "flex", gap: "0.5rem", marginTop: "1.5rem", borderBottom: "1px solid var(--color-border)" }}>
        {([
          ["tickets", openCount > 0 ? `Tickets (${openCount} open)` : "Tickets"],
          ["settings", "Settings"],
        ] as [Tab, string][]).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            style={{
              padding: "0.5rem 1rem",
              background: "none",
              border: "none",
              borderBottom: tab === key ? "2px solid var(--color-primary)" : "2px solid transparent",
              fontWeight: tab === key ? 600 : 400,
              color: tab === key ? "var(--color-primary)" : "var(--color-text-muted)",
              cursor: "pointer",
              marginBottom: "-1px",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "tickets" && (
        <div style={{ marginTop: "1.5rem" }}>
          {/* Filters */}
          <div style={{ display: "flex", gap: "0.75rem", marginBottom: "1rem", flexWrap: "wrap" }}>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
              style={{ padding: "0.4rem 0.75rem", borderRadius: "6px", border: "1px solid var(--color-border)" }}
            >
              <option value="">All statuses</option>
              <option value="open">Open</option>
              <option value="in_progress">In Progress</option>
              <option value="resolved">Resolved</option>
              <option value="closed">Closed</option>
            </select>
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as TypeFilter)}
              style={{ padding: "0.4rem 0.75rem", borderRadius: "6px", border: "1px solid var(--color-border)" }}
            >
              <option value="">All types</option>
              <option value="support">Support tickets</option>
              <option value="feature_request">Feature requests</option>
            </select>
            <span style={{ marginLeft: "auto", color: "var(--color-text-muted)", fontSize: "0.875rem", alignSelf: "center" }}>
              {total} total
            </span>
          </div>

          {loading ? (
            <p style={{ color: "var(--color-text-muted)" }}>Loading…</p>
          ) : loadError ? (
            <div className="card" style={{ padding: "1rem", color: "var(--color-danger, #c33)" }}>{loadError}</div>
          ) : tickets.length === 0 ? (
            <div className="card" style={{ padding: "2rem", textAlign: "center", color: "var(--color-text-muted)" }}>
              No tickets found.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              {tickets.map((ticket) => {
                const expanded = expandedId === ticket.id;
                return (
                  <div
                    key={ticket.id}
                    className="card"
                    style={{ padding: "0", overflow: "hidden" }}
                  >
                    {/* Row */}
                    <button
                      type="button"
                      onClick={() => handleExpand(ticket.id)}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr auto auto auto auto",
                        gap: "1rem",
                        alignItems: "center",
                        width: "100%",
                        padding: "0.875rem 1rem",
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        textAlign: "left",
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 600, marginBottom: "0.15rem" }}>{ticket.subject}</div>
                        <div style={{ fontSize: "0.8rem", color: "var(--color-text-muted)" }}>
                          {ticket.siteName} · {ticket.userEmail} · {new Date(ticket.createdAt).toLocaleDateString()}
                        </div>
                      </div>
                      <span style={{ fontSize: "0.8rem", color: "var(--color-text-muted)", whiteSpace: "nowrap" }}>
                        {ticket.type === "feature_request" ? "Feature" : "Support"}
                      </span>
                      <span style={{
                        fontSize: "0.75rem",
                        fontWeight: 600,
                        color: PRIORITY_COLORS[ticket.priority],
                        textTransform: "capitalize",
                        whiteSpace: "nowrap",
                      }}>
                        {ticket.priority}
                      </span>
                      <span style={{
                        display: "inline-block",
                        padding: "0.2rem 0.5rem",
                        borderRadius: "4px",
                        fontSize: "0.75rem",
                        fontWeight: 600,
                        background: `${STATUS_COLORS[ticket.status]}20`,
                        color: STATUS_COLORS[ticket.status],
                        whiteSpace: "nowrap",
                      }}>
                        {STATUS_LABELS[ticket.status] ?? ticket.status}
                      </span>
                      <span style={{ color: "var(--color-text-muted)", fontSize: "0.85rem" }}>
                        {expanded ? "▲" : "▼"}
                      </span>
                    </button>

                    {/* Expanded detail */}
                    {expanded && (
                      <div style={{ padding: "0 1rem 1rem", borderTop: "1px solid var(--color-border)" }}>
                        <pre style={{
                          marginTop: "1rem",
                          padding: "1rem",
                          background: "var(--color-surface-2, #f5f5f5)",
                          borderRadius: "6px",
                          whiteSpace: "pre-wrap",
                          fontFamily: "inherit",
                          fontSize: "0.9rem",
                          lineHeight: 1.6,
                        }}>
                          {ticket.body}
                        </pre>

                        {/* Status / priority controls */}
                        <div style={{ display: "flex", gap: "1rem", marginTop: "1rem", alignItems: "center" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                            <label style={{ fontSize: "0.875rem", color: "var(--color-text-muted)" }}>Status</label>
                            <select
                              value={ticket.status}
                              disabled={updating === ticket.id}
                              onChange={(e) => handleStatusChange(ticket.id, e.target.value)}
                              style={{ padding: "0.35rem 0.6rem", borderRadius: "6px", border: "1px solid var(--color-border)", fontSize: "0.875rem" }}
                            >
                              <option value="open">Open</option>
                              <option value="in_progress">In Progress</option>
                              <option value="resolved">Resolved</option>
                              <option value="closed">Closed</option>
                            </select>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                            <label style={{ fontSize: "0.875rem", color: "var(--color-text-muted)" }}>Priority</label>
                            <select
                              value={ticket.priority}
                              disabled={updating === ticket.id}
                              onChange={(e) => handlePriorityChange(ticket.id, e.target.value)}
                              style={{ padding: "0.35rem 0.6rem", borderRadius: "6px", border: "1px solid var(--color-border)", fontSize: "0.875rem" }}
                            >
                              <option value="low">Low</option>
                              <option value="normal">Normal</option>
                              <option value="high">High</option>
                            </select>
                          </div>
                          {updating === ticket.id && (
                            <span style={{ fontSize: "0.8rem", color: "var(--color-text-muted)" }}>Saving…</span>
                          )}
                        </div>

                        {/* Comment thread */}
                        <div style={{ marginTop: "1.5rem", borderTop: "1px solid var(--color-border)", paddingTop: "1rem" }}>
                          <div style={{ fontSize: "0.875rem", fontWeight: 600, marginBottom: "0.75rem" }}>Comments</div>

                          {commentsLoading === ticket.id ? (
                            <p style={{ fontSize: "0.875rem", color: "var(--color-text-muted)" }}>Loading…</p>
                          ) : (comments[ticket.id] || []).length === 0 ? (
                            <p style={{ fontSize: "0.875rem", color: "var(--color-text-muted)", marginBottom: "0.75rem" }}>No comments yet.</p>
                          ) : (
                            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", marginBottom: "1rem" }}>
                              {(comments[ticket.id] || []).map((c) => (
                                <div
                                  key={c.id}
                                  style={{
                                    padding: "0.75rem",
                                    borderRadius: "6px",
                                    background: c.isInternal ? "var(--color-warning-subtle, #fffbeb)" : "var(--color-surface-2, #f5f5f5)",
                                    border: c.isInternal ? "1px solid #fde68a" : "1px solid var(--color-border)",
                                  }}
                                >
                                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.35rem" }}>
                                    <span style={{ fontSize: "0.8rem", fontWeight: 600 }}>{c.authorName}</span>
                                    <span style={{ fontSize: "0.75rem", color: "var(--color-text-muted)" }}>
                                      {c.isInternal && <em style={{ marginRight: "0.5rem" }}>internal note · </em>}
                                      {new Date(c.createdAt).toLocaleString()}
                                    </span>
                                  </div>
                                  <div style={{ fontSize: "0.875rem", whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{c.body}</div>
                                </div>
                              ))}
                            </div>
                          )}

                          {/* Compose */}
                          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                            <textarea
                              value={commentBody[ticket.id] || ""}
                              onChange={(e) => setCommentBody((prev) => ({ ...prev, [ticket.id]: e.target.value }))}
                              placeholder="Add a reply or internal note…"
                              rows={3}
                              style={{ resize: "vertical", padding: "0.5rem", borderRadius: "6px", border: "1px solid var(--color-border)", fontSize: "0.875rem", fontFamily: "inherit" }}
                            />
                            <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
                              <button
                                type="button"
                                className="btn btn-primary"
                                style={{ fontSize: "0.875rem", padding: "0.4rem 0.9rem" }}
                                disabled={!commentBody[ticket.id]?.trim() || commentSaving === ticket.id}
                                onClick={() => handleAddComment(ticket.id)}
                              >
                                {commentSaving === ticket.id ? "Sending…" : "Send reply"}
                              </button>
                              <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.875rem", cursor: "pointer" }}>
                                <input
                                  type="checkbox"
                                  checked={commentInternal[ticket.id] ?? false}
                                  onChange={(e) => setCommentInternal((prev) => ({ ...prev, [ticket.id]: e.target.checked }))}
                                />
                                Internal note (not visible to user)
                              </label>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {tab === "settings" && (
        <div style={{ maxWidth: 520, marginTop: "1.5rem" }}>
          {settingsLoading ? (
            <p style={{ color: "var(--color-text-muted)" }}>Loading…</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
              <div className="form-group">
                <label>Notification email addresses</label>
                <input
                  type="text"
                  value={notifEmails}
                  onChange={(e) => setNotifEmails(e.target.value)}
                  placeholder="support@example.com, you@example.com"
                />
                <p style={{ fontSize: "0.8rem", color: "var(--color-text-muted)", margin: "0.35rem 0 0" }}>
                  Comma-separated. These addresses receive an email when a new ticket is submitted.
                </p>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleSaveSettings}
                  disabled={settingsSaving}
                >
                  {settingsSaving ? "Saving…" : "Save"}
                </button>
                {settingsSaved && (
                  <span style={{ fontSize: "0.875rem", color: "#16a34a" }}>Saved</span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
