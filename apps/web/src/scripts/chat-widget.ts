/**
 * Visitor chatbot widget — client behavior.
 *
 * Gated on the server by the "visitor-chatbot" add-on; the widget markup is only
 * rendered by BaseLayout when the add-on is active. This script wires the
 * launcher/panel toggle and talks to POST /api/public/chat.
 *
 * Security: assistant/error text is ALWAYS written via textContent — never
 * innerHTML — so a model (or a compromised API) can't inject markup into the
 * visitor's page. Conversation state is session-only (in memory); nothing is
 * persisted to localStorage in v1.
 */

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

function getApiUrl(): string {
  return document.body.dataset.apiUrl || "";
}

function getSiteId(): string {
  return document.body.dataset.siteId || "";
}

function initChatWidget(): void {
  const root = document.querySelector<HTMLElement>(".cadmus-chat");
  if (!root) return;

  const launcher = root.querySelector<HTMLButtonElement>(".cadmus-chat__launcher");
  const panel = root.querySelector<HTMLElement>(".cadmus-chat__panel");
  const closeBtn = root.querySelector<HTMLButtonElement>(".cadmus-chat__close");
  const messages = root.querySelector<HTMLElement>(".cadmus-chat__messages");
  const form = root.querySelector<HTMLFormElement>(".cadmus-chat__form");
  const input = root.querySelector<HTMLTextAreaElement>(".cadmus-chat__input");
  const sendBtn = root.querySelector<HTMLButtonElement>(".cadmus-chat__send");

  if (!launcher || !panel || !messages || !form || !input || !sendBtn) return;

  const greeting = root.dataset.greeting?.trim() || "Hi! How can I help you today?";

  // Session-only conversation history sent back to the server for context. Capped
  // client-side at the last 10 turns (the server clamps too).
  const history: ChatTurn[] = [];
  let inFlight = false;
  let greeted = false;

  function scrollToBottom(): void {
    messages!.scrollTop = messages!.scrollHeight;
  }

  function addBubble(role: "user" | "assistant" | "system", text: string): HTMLElement {
    const bubble = document.createElement("div");
    bubble.className = `cadmus-chat__msg cadmus-chat__msg--${role}`;
    // textContent only — never innerHTML with model/API text (XSS).
    bubble.textContent = text;
    messages!.appendChild(bubble);
    scrollToBottom();
    return bubble;
  }

  function showTyping(): HTMLElement {
    const el = document.createElement("div");
    el.className = "cadmus-chat__msg cadmus-chat__msg--assistant cadmus-chat__typing";
    el.setAttribute("aria-label", "Assistant is typing");
    for (let i = 0; i < 3; i++) {
      const dot = document.createElement("span");
      dot.className = "cadmus-chat__dot";
      el.appendChild(dot);
    }
    messages!.appendChild(el);
    scrollToBottom();
    return el;
  }

  function setInFlight(state: boolean): void {
    inFlight = state;
    sendBtn!.disabled = state;
    input!.disabled = state;
  }

  function openPanel(): void {
    if (!greeted) {
      addBubble("assistant", greeting);
      greeted = true;
    }
    root!.classList.add("cadmus-chat--open");
    launcher!.setAttribute("aria-expanded", "true");
    panel!.hidden = false;
    // Defer focus until the panel is visible.
    window.setTimeout(() => input!.focus(), 50);
  }

  function closePanel(): void {
    root!.classList.remove("cadmus-chat--open");
    launcher!.setAttribute("aria-expanded", "false");
    panel!.hidden = true;
    launcher!.focus();
  }

  function togglePanel(): void {
    if (root!.classList.contains("cadmus-chat--open")) closePanel();
    else openPanel();
  }

  async function send(text: string): Promise<void> {
    if (inFlight) return;
    const message = text.trim();
    if (!message) return;

    addBubble("user", message);
    history.push({ role: "user", content: message });
    input!.value = "";
    autosize();
    setInFlight(true);
    const typing = showTyping();

    try {
      const res = await fetch(`${getApiUrl()}/api/public/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-site-id": getSiteId() },
        body: JSON.stringify({ message, history: history.slice(-10) }),
      });

      let data: { reply?: string; error?: string } = {};
      try {
        data = (await res.json()) as { reply?: string; error?: string };
      } catch {
        /* non-JSON response — fall through to generic error below */
      }

      typing.remove();

      if (res.ok && data.reply) {
        addBubble("assistant", data.reply);
        history.push({ role: "assistant", content: data.reply });
      } else {
        addBubble("system", data.error || "Something went wrong. Please try again.");
      }
    } catch {
      typing.remove();
      addBubble("system", "Couldn't reach the assistant. Please check your connection and try again.");
    } finally {
      setInFlight(false);
      window.setTimeout(() => input!.focus(), 0);
    }
  }

  function autosize(): void {
    input!.style.height = "auto";
    input!.style.height = `${Math.min(input!.scrollHeight, 120)}px`;
  }

  launcher.addEventListener("click", togglePanel);
  closeBtn?.addEventListener("click", closePanel);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void send(input.value);
  });

  // Enter sends; Shift+Enter inserts a newline.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(input.value);
    }
  });
  input.addEventListener("input", autosize);

  // Escape closes the panel when it's open.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && root.classList.contains("cadmus-chat--open")) {
      closePanel();
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initChatWidget);
} else {
  initChatWidget();
}
