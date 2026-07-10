import { useState, useEffect, useRef, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { ai, type Insight, type ChatStreamEvent } from "../lib/api";

const TOOL_LABELS: Record<string, string> = {
  read_content: "Reading page content…",
  list_content: "Listing pages…",
  search_content: "Searching content…",
  create_content: "Creating page…",
  update_content: "Updating page…",
  get_html_block: "Fetching HTML…",
  update_html_block: "Updating section…",
  delete_content: "Deleting page…",
  set_metadata: "Updating metadata…",
  list_media: "Listing media…",
  update_media: "Updating media…",
  delete_media: "Deleting media…",
  generate_image: "Generating image…",
  update_header: "Updating header…",
  update_footer: "Updating footer…",
  read_header_footer: "Reading header & footer…",
  list_navigation: "Reading navigation…",
  update_navigation: "Updating navigation…",
  create_collection: "Creating collection…",
  update_collection: "Updating collection…",
  delete_collection: "Deleting collection…",
  add_to_collection: "Adding to collection…",
  remove_from_collection: "Removing from collection…",
  list_collections: "Listing collections…",
  get_page_context: "Reading page context…",
  design_page: "Designing page…",
  create_redirect: "Creating redirect…",
  delete_redirect: "Deleting redirect…",
  list_redirects: "Listing redirects…",
  list_team: "Reading team…",
  invite_team_member: "Sending invitation…",
  change_team_role: "Updating team member…",
};

interface ActionResult {
  type: string;
  status: "success" | "error";
  result?: Record<string, unknown>;
  error?: string;
  historyId?: string;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  path?: string;
  turnId?: string;
  turnDecision?: "accepted" | "rejected";
  turnDecisionError?: string;
  actions?: ActionResult[];
  pending?: boolean;
  pendingTool?: string;
}

/**
 * Compact representation of an assistant turn for conversation history.
 * If the turn ran tool actions, summarise them so the AI can see what it
 * already did (and whether the user kept or undid the work) instead of
 * re-running the same plan on the next user message.
 */
function summarizeAssistantTurn(msg: Message): string {
  const parts: string[] = [];
  if (msg.content) parts.push(msg.content);

  if (msg.actions && msg.actions.length > 0) {
    const counts: Record<string, number> = {};
    for (const a of msg.actions) {
      const key = a.status === "error" ? `${a.type} (failed)` : a.type;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    const summary = Object.entries(counts)
      .map(([k, n]) => `${n}× ${k}`)
      .join(", ");
    let suffix = "";
    if (msg.turnDecision === "rejected") {
      suffix = " — UNDONE BY USER (these changes were reverted; do not repeat them)";
    } else if (msg.turnDecision === "accepted") {
      suffix = " — kept";
    }
    parts.push(`[Actions taken: ${summary}${suffix}]`);
  }

  return parts.join("\n\n").trim() || "(no response)";
}

interface AIDrawerProps {
  open: boolean;
  onClose: () => void;
  messages: Message[];
  setMessages: (msgs: Message[]) => void;
  currentPath?: string;
  insights?: Insight[];
  onDismissInsight?: (id: string) => void;
}

export function AIDrawer({ open, onClose, messages, setMessages, currentPath, insights = [], onDismissInsight }: AIDrawerProps) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!sending) inputRef.current?.focus();
  }, [sending]);

  // Focus the input when the drawer opens. Deferred so the open transition has
  // applied (the input isn't focusable until the drawer is visible).
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
}, [messages]);

  const handleSend = async (e: FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    setInput("");
    await sendMessage(text);
  };

  const sendMessage = async (text: string) => {
    if (!text || sending || !user) return;

    const userMsg: Message = { role: "user", content: text, path: currentPath };
    const updated = [...messages, userMsg];
    setMessages(updated);
    setSending(true);

    // Pre-create a placeholder assistant message we'll mutate as the SSE
    // stream lands. Keeping a stable index avoids a race when actions arrive
    // out of order with React re-renders.
    const assistantIdx = updated.length;
    let working: Message[] = [
      ...updated,
      { role: "assistant", content: "", actions: [], pending: true },
    ];
    setMessages(working);

    const updateAssistant = (patch: Partial<Message>) => {
      working = working.map((m, i) => (i === assistantIdx ? { ...m, ...patch } : m));
      setMessages(working);
    };
    const appendAction = (action: ActionResult) => {
      const current = working[assistantIdx];
      const nextActions = [...(current.actions ?? []), action];
      updateAssistant({ actions: nextActions, pendingTool: undefined });
      if (action.status === "success") {
        window.dispatchEvent(new CustomEvent("cadmus:content-updated"));
      }
    };

    try {
      // Prior turns (drop the user message we just appended + the pending placeholder).
      const prior = updated.slice(0, -1);

      // Build history and inject synthetic navigation markers when the user's
      // path changed between turns, so the AI knows earlier references like
      // "this page" pointed to a different location.
      const history: { role: "user" | "assistant"; content: string }[] = [];
      let lastUserPath: string | undefined;
      let lastAssistantUndone = false;
      for (const m of prior) {
        if (m.role === "user") {
          if (m.path && lastUserPath && m.path !== lastUserPath) {
            history.push({
              role: "assistant",
              content: `[Navigation: user moved from ${lastUserPath} to ${m.path}. From here on, "this page/post" refers to ${m.path} unless they say otherwise.]`,
            });
          }
          if (m.path) lastUserPath = m.path;
          history.push({ role: "user", content: m.content });
          lastAssistantUndone = false;
        } else {
          // Replace assistant turns that performed actions with a compact
          // summary so the AI knows what it already did (otherwise it
          // re-runs the same plan on every follow-up). Plain text replies
          // pass through unchanged.
          history.push({ role: "assistant", content: summarizeAssistantTurn(m) });
          lastAssistantUndone = m.turnDecision === "rejected";
        }
      }
      if (currentPath && lastUserPath && currentPath !== lastUserPath) {
        history.push({
          role: "assistant",
          content: `[Navigation: user moved from ${lastUserPath} to ${currentPath}. "This page/post" now refers to ${currentPath}.]`,
        });
      }
      if (lastAssistantUndone) {
        // Strong nudge so the AI doesn't simply redo what was rejected.
        history.push({
          role: "assistant",
          content: "[The user undid my previous turn. I should treat that work as rejected and try a different approach instead of repeating it.]",
        });
      }

      const onEvent = (evt: ChatStreamEvent) => {
        if (evt.event === "start") {
          updateAssistant({ turnId: evt.data.turnId });
        } else if (evt.event === "tool_start") {
          updateAssistant({ pendingTool: evt.data.name });
        } else if (evt.event === "action") {
          appendAction(evt.data.action);
        } else if (evt.event === "text") {
          // Each round can produce a chunk of assistant prose. Concatenate
          // with a separator so multi-round narration reads naturally.
          const current = working[assistantIdx];
          const next = current.content ? `${current.content}\n\n${evt.data.text}` : evt.data.text;
          updateAssistant({ content: next });
        }
      };

      const res = await ai.chat(text, history.length > 0 ? history : undefined, currentPath, onEvent);
      // Final reconcile — server's `done` is authoritative. Use it to fill
      // any text or actions that didn't arrive via incremental events.
      updateAssistant({
        content: res.text || working[assistantIdx].content,
        actions: res.actions.length ? res.actions : working[assistantIdx].actions,
        turnId: res.turnId,
        pending: false,
        pendingTool: undefined,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Something went wrong. Please try again.";
      const current = working[assistantIdx];
      updateAssistant({
        content: current.content || errorMsg,
        pending: false,
        pendingTool: undefined,
      });
    } finally {
      setSending(false);
    }
  };

  const decideTurn = async (msgIdx: number, decision: "accepted" | "rejected") => {
    const msg = messages[msgIdx];
    if (!msg?.turnId || msg.turnDecision) return;
    try {
      await ai.decideTurn(msg.turnId, decision);
      const nextMessages = messages.map((m, i) =>
        i === msgIdx ? { ...m, turnDecision: decision, turnDecisionError: undefined } : m,
      );
      setMessages(nextMessages);
      if (decision === "rejected") {
        window.dispatchEvent(new CustomEvent("cadmus:content-updated"));
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Decision failed";
      const nextMessages = messages.map((m, i) =>
        i === msgIdx ? { ...m, turnDecisionError: errorMsg } : m,
      );
      setMessages(nextMessages);
    }
  };

  function renderTurnDecisionBar(msg: Message, msgIdx: number) {
    // Only show when there's something to undo — i.e. at least one action succeeded
    // with a historyId. Read-only turns have no history rows to roll back.
    const hasUndoable = msg.actions?.some((a) => a.historyId && a.status === "success");
    if (!msg.turnId || !hasUndoable) return null;
    if (msg.turnDecision === "accepted") {
      return <div className="action-card__decision action-card__decision--kept">Kept</div>;
    }
    if (msg.turnDecision === "rejected") {
      return <div className="action-card__decision action-card__decision--undone">Undone</div>;
    }
    return (
      <div className="action-card__decision" style={{ marginTop: "0.5rem" }}>
        <button type="button" className="btn btn-small" onClick={() => decideTurn(msgIdx, "accepted")}>Keep</button>
        <button type="button" className="btn btn-small btn-ghost" onClick={() => decideTurn(msgIdx, "rejected")}>Undo</button>
        {msg.turnDecisionError && <span className="action-card__decision-error">{msg.turnDecisionError}</span>}
      </div>
    );
  }

  function renderActionCard(action: ActionResult) {
    if (action.status === "error") {
      const needsInterview = action.type === "DESIGN_PAGE" && action.error?.includes("interview");
      return (
        <div className="action-card action-card--error">
          <span className="action-card__icon">!</span>
          <span>
            {action.error}
            {needsInterview && (
              <> <button type="button" className="action-card__link" onClick={() => { window.location.href = "/admin/onboarding"; onClose(); }}>Start interview →</button></>
            )}
          </span>
        </div>
      );
    }

    const r = action.result || {};

    if (action.type === "DESIGN_PAGE") {
      return (
        <div className="action-card action-card--success">
          <span className="action-card__icon">&#10003;</span>
          <div className="action-card__body">
            <strong>Designed {r.status === "draft" ? "draft " : ""}page:</strong> {String(r.title)}
            {r.blockCount ? <span> — {String(r.blockCount)} sections</span> : null}
            <button
              type="button"
              className="action-card__link"
              onClick={() => {
                navigate(`/content/${r.id}`);
                onClose();
              }}
            >
              Edit &rarr;
            </button>
          </div>
        </div>
      );
    }

    if (action.type === "CREATE_CONTENT" || action.type === "UPDATE_CONTENT") {
      const verb = action.type === "CREATE_CONTENT" ? "Created" : "Updated";
      const typeLabel = r.type === "post" ? "post" : "page";
      return (
        <div className="action-card action-card--success">
          <span className="action-card__icon">&#10003;</span>
          <div className="action-card__body">
            <strong>{verb} {r.status === "draft" ? "draft " : ""}{typeLabel}:</strong> {String(r.title)}
            {r.metaDescription ? <div className="action-card__meta">{String(r.metaDescription)}</div> : null}
            {r.featuredImage ? <img src={String(r.featuredImage)} alt="" className="action-card__img" /> : null}
            <button
              type="button"
              className="action-card__link"
              onClick={() => {
                navigate(`/content/${r.id}`);
                onClose();
              }}
            >
              Edit &rarr;
            </button>
          </div>
        </div>
      );
    }

    if (action.type === "SET_METADATA") {
      return (
        <div className="action-card action-card--success">
          <span className="action-card__icon">&#10003;</span>
          <div className="action-card__body">
            <strong>Updated metadata</strong>
            {r.metaDescription ? <span> — meta description set</span> : null}
            {r.featuredImage ? <span> — featured image set</span> : null}
          </div>
        </div>
      );
    }

    if (action.type === "GENERATE_IMAGE") {
      return (
        <div className="action-card action-card--success">
          <span className="action-card__icon">&#10003;</span>
          <div className="action-card__body">
            <strong>Generated image</strong>
            {r.contentId ? <span> — set as featured image</span> : null}
            {r.url ? (
              <img src={String(r.url)} alt="AI generated" style={{ maxWidth: "200px", borderRadius: "4px", marginTop: "0.5rem", display: "block" }} />
            ) : null}
          </div>
        </div>
      );
    }

    if (action.type === "UPDATE_NAVIGATION") {
      const items = r.items as Array<{ label: string; url: string }> | undefined;
      return (
        <div className="action-card action-card--success">
          <span className="action-card__icon">&#10003;</span>
          <div className="action-card__body">
            <strong>Updated {String(r.location)} menu</strong>
            {items ? <span> — {items.length} item{items.length !== 1 ? "s" : ""}</span> : null}
          </div>
        </div>
      );
    }

    if (action.type === "CREATE_COLLECTION") {
      return (
        <div className="action-card action-card--success">
          <span className="action-card__icon">&#10003;</span>
          <div className="action-card__body">
            <strong>Created {String(r.type)}:</strong> {String(r.name)}
          </div>
        </div>
      );
    }

    if (action.type === "ADD_TO_COLLECTION") {
      return (
        <div className="action-card action-card--success">
          <span className="action-card__icon">&#10003;</span>
          <span>Added to collection</span>
        </div>
      );
    }

    if (action.type === "REMOVE_FROM_COLLECTION") {
      return (
        <div className="action-card action-card--success">
          <span className="action-card__icon">&#10003;</span>
          <span>Removed from collection</span>
        </div>
      );
    }

    if (action.type === "DELETE_COLLECTION") {
      return (
        <div className="action-card action-card--success">
          <span className="action-card__icon">&#10003;</span>
          <div className="action-card__body">
            <strong>Deleted collection:</strong> {String(r.name)}
          </div>
        </div>
      );
    }

    if (action.type === "DELETE_CONTENT") {
      return (
        <div className="action-card action-card--success">
          <span className="action-card__icon">&#10003;</span>
          <div className="action-card__body">
            <strong>Deleted {String(r.type)}:</strong> {String(r.title ?? r.slug)}
          </div>
        </div>
      );
    }

    if (action.type === "CREATE_REDIRECT") {
      return (
        <div className="action-card action-card--success">
          <span className="action-card__icon">&#10003;</span>
          <div className="action-card__body">
            <strong>Created redirect:</strong> {String(r.fromPath)} &rarr; {String(r.toUrl)}
            <span style={{ marginLeft: "0.5rem", color: "var(--color-text-secondary)", fontSize: "0.8rem" }}>[{String(r.statusCode)}]</span>
          </div>
        </div>
      );
    }

    if (action.type === "DELETE_REDIRECT") {
      return (
        <div className="action-card action-card--success">
          <span className="action-card__icon">&#10003;</span>
          <div className="action-card__body">
            <strong>Deleted redirect:</strong> {String(r.fromPath)} &rarr; {String(r.toUrl)}
          </div>
        </div>
      );
    }

    if (action.type === "INVITE_TEAM_MEMBER") {
      return (
        <div className="action-card action-card--success">
          <span className="action-card__icon">&#10003;</span>
          <div className="action-card__body">
            <strong>Invited team member:</strong> {String(r.email)} as <em>{String(r.role)}</em>
          </div>
        </div>
      );
    }

    if (action.type === "CHANGE_TEAM_ROLE") {
      return (
        <div className="action-card action-card--success">
          <span className="action-card__icon">&#10003;</span>
          <div className="action-card__body">
            <strong>Changed role:</strong> {String(r.email)} &rarr; <em>{String(r.newRole)}</em>
            <span style={{ marginLeft: "0.5rem", color: "var(--color-text-secondary)", fontSize: "0.8rem" }}>(was {String(r.oldRole)})</span>
          </div>
        </div>
      );
    }

    if (action.type === "DELETE_MEDIA") {
      return (
        <div className="action-card action-card--success">
          <span className="action-card__icon">&#10003;</span>
          <div className="action-card__body">
            <strong>Deleted media:</strong> {String(r.filename)}
          </div>
        </div>
      );
    }

    if (action.type === "UPDATE_DESIGN_INTENT") {
      return (
        <div className="action-card action-card--success">
          <span className="action-card__icon">&#10003;</span>
          <div className="action-card__body">
            <strong>Updated the site's design direction</strong>
            {r.version ? <span> — now v{String(r.version)}</span> : null}
            <div className="action-card__meta">Future pages and edits will follow this direction. You can review or fine-tune it in Settings → Design Direction.</div>
          </div>
        </div>
      );
    }

    return (
      <div className="action-card action-card--success">
        <span className="action-card__icon">&#10003;</span>
        <span>Action completed: {action.type}</span>
      </div>
    );
  }

  function renderMessageContent(text: string) {
    // Simple markdown-like rendering for AI responses
    const lines = text.split("\n");
    const elements: React.ReactNode[] = [];
    let key = 0;

    for (const line of lines) {
      if (!line.trim()) {
        elements.push(<br key={key++} />);
        continue;
      }

      // Bold
      let processed = line.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
      // Italic
      processed = processed.replace(/\*(.+?)\*/g, "<em>$1</em>");
      // Inline code
      processed = processed.replace(/`(.+?)`/g, "<code>$1</code>");

      elements.push(
        <p key={key++} dangerouslySetInnerHTML={{ __html: processed }} style={{ margin: "0.25rem 0" }} />
      );
    }

    return elements;
  }

  return (
    <>
      {open && <div className="ai-drawer-backdrop" onClick={onClose} />}
      <div className={`ai-drawer ${open ? "open" : ""}`}>
        <div className="ai-drawer-header">
          <h3>AI Assistant</h3>
          <button type="button" className="ai-drawer-close" onClick={onClose}>
            &times;
          </button>
        </div>
        {insights.length > 0 && (
          <div className="ai-suggestions">
            <div className="ai-suggestions__header">
              Suggestion{insights.length === 1 ? "" : "s"} for this page
            </div>
            {insights.map((insight) => (
              <div key={insight.id} className="ai-suggestion-card">
                <div className="ai-suggestion-card__title">{insight.title}</div>
                <div className="ai-suggestion-card__rationale">{insight.rationale}</div>
                <div className="ai-suggestion-card__actions">
                  {insight.prompt && (
                    <button
                      type="button"
                      className="btn btn-small btn-primary"
                      disabled={sending}
                      onClick={() => {
                        sendMessage(insight.prompt!);
                        onDismissInsight?.(insight.id);
                      }}
                    >
                      Ask AI to fix
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-small btn-ghost"
                    onClick={() => onDismissInsight?.(insight.id)}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="chat-messages">
          {messages.map((msg, i) => (
            <div key={i} className={`message ${msg.role === "user" ? "user" : "ai"}`}>
              {msg.role === "user" ? (
                <p>{msg.content}</p>
              ) : (
                <>
                  {renderMessageContent(msg.content)}
                  {msg.actions?.map((action, j) => (
                    <div key={j} style={{ marginTop: "0.5rem" }}>
                      {renderActionCard(action)}
                    </div>
                  ))}
                  {msg.pending && (
                    <p style={{ margin: "0.25rem 0", opacity: 0.7 }}>
                      {TOOL_LABELS[msg.pendingTool ?? ""] ?? (msg.pendingTool ? `Running ${msg.pendingTool}` : "Working")}
                      <span className="thinking-dots" />
                    </p>
                  )}
                  {renderTurnDecisionBar(msg, i)}
                </>
              )}
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>
        <form className="chat-input" onSubmit={handleSend}>
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask the AI anything about your site..."
            disabled={sending}
          />
          <button type="submit" className="btn btn-primary" disabled={sending}>
            Send
          </button>
        </form>
      </div>
    </>
  );
}
