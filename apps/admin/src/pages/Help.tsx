import { useState, useEffect, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { support, type SupportTicket, type TicketComment } from "../lib/api";

type Tab = "submit" | "my-tickets";
type TicketType = "support" | "feature_request";

function statusLabels(t: TFunction): Record<string, string> {
  return {
    open: t("help.status.open"),
    in_progress: t("help.status.inProgress"),
    resolved: t("help.status.resolved"),
    closed: t("help.status.closed"),
  };
}

const STATUS_COLORS: Record<string, string> = {
  open: "#2563eb",
  in_progress: "#d97706",
  resolved: "#16a34a",
  closed: "#6b7280",
};

export function Help() {
  const { t } = useTranslation();
  const STATUS_LABELS = statusLabels(t);
  const [tab, setTab] = useState<Tab>("submit");

  // Submit form state
  const [type, setType] = useState<TicketType>("support");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [priority, setPriority] = useState("normal");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");

  // My tickets state
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [loadingTickets, setLoadingTickets] = useState(false);
  const [expandedTicketId, setExpandedTicketId] = useState<string | null>(null);
  const [ticketComments, setTicketComments] = useState<Record<string, TicketComment[]>>({});
  const [commentsLoading, setCommentsLoading] = useState<string | null>(null);

  useEffect(() => {
    if (tab === "my-tickets") {
      setLoadingTickets(true);
      support.mine()
        .then((res) => setTickets(res.tickets))
        .catch(() => setTickets([]))
        .finally(() => setLoadingTickets(false));
    }
  }, [tab]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await support.submit({ type, subject, body, priority });
      setSubmitted(true);
      setSubject("");
      setBody("");
      setPriority("normal");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("help.errors.submitFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  const handleAnother = () => {
    setSubmitted(false);
    setType("support");
  };

  const handleExpandTicket = async (ticketId: string) => {
    const isExpanding = expandedTicketId !== ticketId;
    setExpandedTicketId(isExpanding ? ticketId : null);
    if (isExpanding && !ticketComments[ticketId]) {
      setCommentsLoading(ticketId);
      try {
        const res = await support.comments(ticketId);
        setTicketComments((prev) => ({ ...prev, [ticketId]: res.comments }));
      } catch {
        setTicketComments((prev) => ({ ...prev, [ticketId]: [] }));
      } finally {
        setCommentsLoading(null);
      }
    }
  };

  return (
    <div className="page">
      <h2>{t("help.title")}</h2>
      <p style={{ color: "var(--color-text-muted)", marginTop: "0.25rem" }}>
        {t("help.intro")}
      </p>

      <div style={{ display: "flex", gap: "0.5rem", marginTop: "1.5rem", borderBottom: "1px solid var(--color-border)" }}>
        {([["submit", t("help.tabs.submit")], ["my-tickets", t("help.tabs.myTickets")]] as const).map(([key, label]) => (
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

      {tab === "submit" && (
        <div style={{ maxWidth: 600, marginTop: "1.5rem" }}>
          {submitted ? (
            <div className="card" style={{ padding: "2rem", textAlign: "center" }}>
              <div style={{ fontSize: "2rem", marginBottom: "0.75rem" }}>✓</div>
              <h3 style={{ margin: "0 0 0.5rem" }}>{t("help.submitted.title")}</h3>
              <p style={{ color: "var(--color-text-muted)", margin: "0 0 1.5rem" }}>
                {t("help.submitted.body")} <strong>{t("help.tabs.myTickets")}</strong>.
              </p>
              <button type="button" className="btn btn-secondary" onClick={handleAnother}>
                {t("help.submitted.another")}
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
              {error && <div className="auth-error">{error}</div>}

              <div className="form-group">
                <label>{t("help.form.typeLabel")}</label>
                <div style={{ display: "flex", gap: "0.75rem" }}>
                  {([["support", t("help.form.typeSupport")], ["feature_request", t("help.form.typeFeature")]] as const).map(([val, label]) => (
                    <label
                      key={val}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.4rem",
                        cursor: "pointer",
                        padding: "0.5rem 0.75rem",
                        border: `1px solid ${type === val ? "var(--color-primary)" : "var(--color-border)"}`,
                        borderRadius: "6px",
                        background: type === val ? "var(--color-primary-subtle, #eff6ff)" : "transparent",
                      }}
                    >
                      <input
                        type="radio"
                        name="type"
                        value={val}
                        checked={type === val}
                        onChange={() => setType(val)}
                        style={{ margin: 0 }}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </div>

              <div className="form-group">
                <label>{t("help.form.subjectLabel")}</label>
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder={type === "support" ? t("help.form.subjectPlaceholderSupport") : t("help.form.subjectPlaceholderFeature")}
                  required
                />
              </div>

              <div className="form-group">
                <label>{type === "support" ? t("help.form.bodyLabelSupport") : t("help.form.bodyLabelFeature")}</label>
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={6}
                  placeholder={
                    type === "support"
                      ? t("help.form.bodyPlaceholderSupport")
                      : t("help.form.bodyPlaceholderFeature")
                  }
                  required
                  style={{ resize: "vertical" }}
                />
              </div>

              {type === "support" && (
                <div className="form-group">
                  <label>{t("help.form.priorityLabel")}</label>
                  <select value={priority} onChange={(e) => setPriority(e.target.value)}>
                    <option value="low">{t("help.form.priorityLow")}</option>
                    <option value="normal">{t("help.form.priorityNormal")}</option>
                    <option value="high">{t("help.form.priorityHigh")}</option>
                  </select>
                </div>
              )}

              <div>
                <button type="submit" className="btn btn-primary" disabled={submitting}>
                  {submitting ? t("help.form.submitting") : t("help.form.submit")}
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {tab === "my-tickets" && (
        <div style={{ marginTop: "1.5rem" }}>
          {loadingTickets ? (
            <p style={{ color: "var(--color-text-muted)" }}>{t("common.loading")}</p>
          ) : tickets.length === 0 ? (
            <div className="card" style={{ padding: "2rem", textAlign: "center", color: "var(--color-text-muted)" }}>
              {t("help.tickets.empty")} <strong>{t("help.tabs.submit")}</strong>.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              {tickets.map((ticket) => {
                const isExpanded = expandedTicketId === ticket.id;
                return (
                  <div key={ticket.id} className="card" style={{ padding: 0, overflow: "hidden" }}>
                    <button
                      type="button"
                      onClick={() => handleExpandTicket(ticket.id)}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr auto auto auto",
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
                        <div style={{ fontWeight: 600, marginBottom: "0.15rem", fontSize: "0.9rem" }}>{ticket.subject}</div>
                        <div style={{ fontSize: "0.8rem", color: "var(--color-text-muted)" }}>
                          {ticket.type === "feature_request" ? t("help.form.typeFeature") : t("help.form.typeSupport")} · {new Date(ticket.createdAt).toLocaleDateString()}
                        </div>
                      </div>
                      <span style={{ fontSize: "0.8rem", color: "var(--color-text-muted)", textTransform: "capitalize", whiteSpace: "nowrap" }}>
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
                      <span style={{ color: "var(--color-text-muted)", fontSize: "0.85rem" }}>{isExpanded ? "▲" : "▼"}</span>
                    </button>

                    {isExpanded && (
                      <div style={{ padding: "0 1rem 1rem", borderTop: "1px solid var(--color-border)" }}>
                        <pre style={{
                          marginTop: "1rem",
                          padding: "1rem",
                          background: "var(--color-surface-2, #f5f5f5)",
                          borderRadius: "6px",
                          whiteSpace: "pre-wrap",
                          fontFamily: "inherit",
                          fontSize: "0.875rem",
                          lineHeight: 1.6,
                        }}>
                          {ticket.body}
                        </pre>

                        {/* Reply thread */}
                        {commentsLoading === ticket.id ? (
                          <p style={{ fontSize: "0.875rem", color: "var(--color-text-muted)", marginTop: "1rem" }}>{t("help.tickets.loadingReplies")}</p>
                        ) : (ticketComments[ticket.id] || []).length > 0 ? (
                          <div style={{ marginTop: "1rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                            <div style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--color-text-muted)" }}>{t("help.tickets.repliesHeading")}</div>
                            {(ticketComments[ticket.id] || []).map((c) => (
                              <div
                                key={c.id}
                                style={{
                                  padding: "0.75rem",
                                  background: "var(--color-surface-2, #f5f5f5)",
                                  borderRadius: "6px",
                                  border: "1px solid var(--color-border)",
                                }}
                              >
                                <div style={{ fontSize: "0.75rem", color: "var(--color-text-muted)", marginBottom: "0.35rem" }}>
                                  {c.authorName} · {new Date(c.createdAt).toLocaleString()}
                                </div>
                                <div style={{ fontSize: "0.875rem", whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{c.body}</div>
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
