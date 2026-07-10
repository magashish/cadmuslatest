import { useState, useEffect, useRef, type FormEvent, type ChangeEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { ai, site, content, media, navigation } from "../lib/api";
import type { SiteBrief, SiteBriefPage } from "@cadmus/shared";

type OnboardingStep = "choose" | "interview" | "brief-paste" | "review" | "launch";

interface Message {
  role: "user" | "assistant";
  content: string;
}

const BRIEF_MARKER = "[BRIEF_COMPLETE]";

// ---------------------------------------------------------------------------
// Step Indicator
// ---------------------------------------------------------------------------

const STEP_ORDER: OnboardingStep[] = ["interview", "review", "launch"];
const STEP_LABELS: Record<string, string> = {
  interview: "Interview",
  review: "Review",
  launch: "Launch",
};

function StepIndicator({ step }: { step: OnboardingStep }) {
  if (step === "choose" || step === "brief-paste") return null;

  const steps = STEP_ORDER;
  const currentIdx = steps.indexOf(step);

  return (
    <div className="wizard-steps">
      {steps.map((s, i) => {
        const state =
          i < currentIdx ? "completed" : i === currentIdx ? "active" : "";
        return (
          <div key={s} style={{ display: "flex", alignItems: "center" }}>
            {i > 0 && (
              <div
                className={`wizard-step-line${i <= currentIdx ? " completed" : ""}`}
              />
            )}
            <div className={`wizard-step ${state}`}>
              <span className="wizard-step-number">
                {i < currentIdx ? "\u2713" : i + 1}
              </span>
              <span>{STEP_LABELS[s]}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1: Interview
// ---------------------------------------------------------------------------

function InterviewStep({
  messages,
  setMessages,
  onComplete,
  logoUrl,
  onLogoChange,
  briefPromiseRef,
}: {
  messages: Message[];
  setMessages: (msgs: Message[]) => void;
  onComplete: (msgs: Message[]) => void;
  logoUrl: string | undefined;
  onLogoChange: (url: string | undefined) => void;
  briefPromiseRef: React.MutableRefObject<Promise<any> | null>;
}) {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const kickedOff = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const countdownRef = useRef<Message[] | null>(null);

  useEffect(() => {
    if (!sending && countdown === null) {
      inputRef.current?.focus();
    }
  }, [sending, countdown]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  // Kick off interview on mount
  useEffect(() => {
    if (kickedOff.current || messages.length > 0) return;
    kickedOff.current = true;

    (async () => {
      setSending(true);
      try {
        const res = await ai.interview(
          "Hi, I'd like to set up my website.",
          []
        );
        const cleaned = stripMarker(res.response);
        setMessages([
          { role: "user", content: "Hi, I'd like to set up my website." },
          { role: "assistant", content: cleaned },
        ]);
      } catch {
        setMessages([
          {
            role: "assistant",
            content:
              "Welcome! Let's set up your website. Tell me about your business.",
          },
        ]);
      } finally {
        setSending(false);
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    scrollToBottom();
  }, [messages, countdown]);

  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) {
      onComplete(countdownRef.current!);
      return;
    }
    const timer = setTimeout(() => setCountdown(countdown - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown, onComplete]);

  function stripMarker(text: string): string {
    return text.replace(BRIEF_MARKER, "").trim();
  }

  const handleSend = async (e: FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || sending) return;

    const userMsg: Message = { role: "user", content: text };
    const history = [...messages, userMsg];
    setMessages(history);
    setInput("");
    setSending(true);

    try {
      const res = await ai.interview(text, messages);
      const isComplete = res.response.includes(BRIEF_MARKER);
      const cleaned = stripMarker(res.response);
      const aiMsg: Message = { role: "assistant", content: cleaned };
      const updated = [...history, aiMsg];
      setMessages(updated);

      if (isComplete) {
        countdownRef.current = updated;
        // Start brief extraction immediately — runs during the 3s countdown
        briefPromiseRef.current = ai.extractBrief(updated);
        setCountdown(5);
      }
    } catch {
      setMessages([
        ...history,
        {
          role: "assistant",
          content: "Something went wrong. Please try again.",
        },
      ]);
    } finally {
      setSending(false);
    }
  };

  const handleLogoUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const res = await media.upload(file) as { storageUrl?: string; url?: string };
      onLogoChange(res.storageUrl ?? res.url);
    } catch {
      // Silently fail — logo is optional
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <div className="chat-container">
      <div className="chat-messages">
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`message ${msg.role === "user" ? "user" : "ai"}`}
          >
            <p>{msg.content}</p>
          </div>
        ))}
        {sending && (
          <div className="message ai">
            <p>Thinking<span className="thinking-dots" /></p>
          </div>
        )}
        {countdown !== null && (
          <div className="message ai">
            <p style={{ fontWeight: 600 }}>
              Interview complete! Reviewing in {countdown}...
            </p>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>
      <div className="chat-logo-upload">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handleLogoUpload}
          style={{ display: "none" }}
          id="logo-upload"
        />
        {logoUrl ? (
          <div className="chat-logo-preview">
            <img src={logoUrl} alt="Logo" />
            <button
              type="button"
              className="chat-logo-remove"
              onClick={() => onLogoChange(undefined)}
              title="Remove logo"
            >
              &#x2715;
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="chat-logo-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? "Uploading..." : "Upload Logo (optional)"}
          </button>
        )}
      </div>
      <form className="chat-input" onSubmit={handleSend}>
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type your answer..."
          disabled={sending || countdown !== null}
        />
        <button type="submit" className="btn btn-primary" disabled={sending || countdown !== null}>
          Send
        </button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 0: Choose path
// ---------------------------------------------------------------------------

function ChooseStep({ onChooseInterview, onChooseBrief }: {
  onChooseInterview: () => void;
  onChooseBrief: () => void;
}) {
  return (
    <div className="choose-step">
      <div className="choose-cards">
        <div className="choose-card">
          <div className="choose-card-icon" aria-hidden="true">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </div>
          <h3 className="choose-card-title">Build my voice</h3>
          <p className="choose-card-desc">
            Answer a few questions and we'll craft your site's voice and design
          </p>
          <button
            type="button"
            className="btn btn-primary btn-full"
            onClick={onChooseInterview}
          >
            Start interview
          </button>
        </div>

        <div className="choose-card">
          <div className="choose-card-icon" aria-hidden="true">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
              <polyline points="10 9 9 9 8 9" />
            </svg>
          </div>
          <h3 className="choose-card-title">I have a brief</h3>
          <p className="choose-card-desc">
            Paste your copy, brand guidelines, or notes and we'll set everything up
          </p>
          <button
            type="button"
            className="btn btn-primary btn-full"
            onClick={onChooseBrief}
          >
            Paste my brief
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 0b: Brief paste path
// ---------------------------------------------------------------------------

function BriefPasteStep({ onComplete, onBack, text, onTextChange }: {
  onComplete: (brief: SiteBrief) => void;
  onBack: () => void;
  text: string;
  onTextChange: (text: string) => void;
}) {
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
      const content = evt.target?.result;
      if (typeof content === "string") {
        onTextChange(text ? `${text}\n\n${content}` : content);
      }
    };

    if (file.type === "application/pdf") {
      // PDFs can't be read as text client-side — inform the user
      setError("PDF files can't be read directly. Please copy and paste the text content instead.");
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    reader.readAsText(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleContinue = async () => {
    if (!text.trim()) return;
    setError(null);
    setParsing(true);
    try {
      const res = await ai.parseBrief(text.trim());
      const extractedPages: SiteBriefPage[] = Array.isArray(res.brief.pages)
        ? (res.brief.pages as unknown as SiteBriefPage[])
        : [
            { type: "homepage", slug: "home", purpose: "Main landing page" },
            { type: "about", slug: "about", purpose: "About the business" },
          ];
      onComplete({
        businessName: res.brief.businessName ?? "",
        businessDescription: res.brief.businessDescription ?? "",
        location: res.brief.location ?? undefined,
        targetAudience: res.brief.targetAudience ?? undefined,
        differentiators: res.brief.differentiators ?? undefined,
        tone: res.brief.tone ?? undefined,
        primaryGoal: res.brief.primaryGoal ?? undefined,
        brandColors: res.brief.brandColors ?? undefined,
        constraints: res.brief.constraints ?? undefined,
        rawBrief: res.brief.rawBrief ?? undefined,
        pages: extractedPages,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to parse brief. Please try again.");
    } finally {
      setParsing(false);
    }
  };

  return (
    <div className="brief-paste-step">
      <p style={{ color: "var(--color-text-muted)", marginBottom: "1.25rem" }}>
        Paste any copy, brand guidelines, or notes about your site below. We'll extract the key details automatically.
      </p>

      <div className="form-group">
        <textarea
          rows={10}
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          placeholder="Paste your brief, copy, or brand notes here…"
          style={{ width: "100%", resize: "vertical" }}
          disabled={parsing}
        />
      </div>

      <div className="form-group" style={{ marginTop: "0.75rem" }}>
        <input
          ref={fileInputRef}
          type="file"
          accept=".txt,.md,.pdf"
          onChange={handleFileChange}
          style={{ display: "none" }}
          id="brief-file-upload"
        />
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => fileInputRef.current?.click()}
          disabled={parsing}
        >
          Upload .txt or .md file
        </button>
        <span style={{ fontSize: "0.8rem", color: "var(--color-text-muted)", marginLeft: "0.5rem" }}>
          File contents will be appended to the text above
        </span>
      </div>

      {error && (
        <p style={{ color: "#dc2626", fontSize: "0.875rem", marginBottom: "1rem" }}>{error}</p>
      )}

      <div className="review-buttons">
        <button
          type="button"
          className="btn btn-full"
          onClick={onBack}
          disabled={parsing}
        >
          Back
        </button>
        <button
          type="button"
          className="btn btn-primary btn-full"
          onClick={handleContinue}
          disabled={parsing || !text.trim()}
        >
          {parsing ? "Analyzing…" : "Continue"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add Page Row (inline form for adding a page to the plan)
// ---------------------------------------------------------------------------

const PAGE_TYPE_OPTIONS = [
  { value: "homepage", label: "Homepage", slug: "home" },
  { value: "about", label: "About", slug: "about" },
  { value: "services", label: "Services", slug: "services" },
  { value: "contact", label: "Contact", slug: "contact" },
  { value: "blog", label: "Blog", slug: "blog" },
  { value: "pricing", label: "Pricing", slug: "pricing" },
  { value: "faq", label: "FAQ", slug: "faq" },
  { value: "portfolio", label: "Portfolio", slug: "portfolio" },
  { value: "testimonials", label: "Testimonials", slug: "testimonials" },
  { value: "features", label: "Features", slug: "features" },
  { value: "landing", label: "Landing Page", slug: "landing" },
  { value: "custom", label: "Custom...", slug: "" },
];

function AddPageRow({ onAdd }: { onAdd: (page: SiteBriefPage) => void }) {
  const [selectedType, setSelectedType] = useState("");
  const [customSlug, setCustomSlug] = useState("");
  const [purpose, setPurpose] = useState("");

  const handleAdd = () => {
    const option = PAGE_TYPE_OPTIONS.find((o) => o.value === selectedType);
    if (!option) return;
    const slug = option.value === "custom" ? customSlug.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-") : option.slug;
    if (!slug) return;
    onAdd({ type: option.value === "custom" ? customSlug.trim() : option.value, slug, purpose: purpose.trim() || `${option.label} page` });
    setSelectedType("");
    setCustomSlug("");
    setPurpose("");
  };

  return (
    <div className="add-page-row">
      <select value={selectedType} onChange={(e) => setSelectedType(e.target.value)}>
        <option value="">Add a page...</option>
        {PAGE_TYPE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {selectedType === "custom" && (
        <input
          type="text"
          placeholder="Page name (e.g. careers)"
          value={customSlug}
          onChange={(e) => setCustomSlug(e.target.value)}
        />
      )}
      {selectedType && (
        <>
          <input
            type="text"
            placeholder="Purpose (optional)"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={handleAdd}
            disabled={selectedType === "custom" && !customSlug.trim()}
          >
            Add
          </button>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2: Review Brief
// ---------------------------------------------------------------------------

function ReviewStep({
  brief,
  setBrief,
  siteId,
  onContinue,
  onBack,
  logoUrl,
  onLogoChange,
  inspirationImages,
  onInspirationChange,
}: {
  brief: SiteBrief;
  setBrief: (b: SiteBrief) => void;
  siteId: string;
  onContinue: () => void;
  onBack: () => void;
  logoUrl: string | undefined;
  onLogoChange: (url: string | undefined) => void;
  inspirationImages: string[];
  onInspirationChange: (urls: string[]) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [generatingLogo, setGeneratingLogo] = useState(false);
  const [logoError, setLogoError] = useState("");
  const [uploadingInspiration, setUploadingInspiration] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inspirationInputRef = useRef<HTMLInputElement>(null);

  // Hold the constraints textarea as raw text so the user can type freely
  // (trailing spaces, blank lines). We only parse into the string[] on blur —
  // parsing on every keystroke would strip whitespace mid-typing.
  const [constraintsText, setConstraintsText] = useState((brief.constraints ?? []).join("\n"));

  const update = (field: keyof SiteBrief, value: string) => {
    setBrief({ ...brief, [field]: value });
  };

  const handleLogoUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const res = await media.upload(file) as { storageUrl?: string; url?: string };
      onLogoChange(res.storageUrl ?? res.url);
    } catch {
      // Silently fail
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleLogoGenerate = async () => {
    setGeneratingLogo(true);
    setLogoError("");
    try {
      const res = await ai.generateLogo();
      onLogoChange(res.url);
    } catch (e) {
      setLogoError(e instanceof Error ? e.message : "Generation failed");
    } finally {
      setGeneratingLogo(false);
    }
  };

  const handleInspirationUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files?.length) return;
    setUploadingInspiration(true);
    try {
      for (const file of Array.from(files)) {
        if (inspirationImages.length >= 5) break;
        const res = await media.upload(file) as { storageUrl?: string; url?: string };
        const url = res.storageUrl ?? res.url;
        if (url) {
          onInspirationChange([...inspirationImages, url]);
        }
      }
    } catch {
      // Silently fail — inspiration is optional
    } finally {
      setUploadingInspiration(false);
      if (inspirationInputRef.current) inspirationInputRef.current.value = "";
    }
  };

  const handleContinue = async () => {
    setSaving(true);
    // Parse constraints from the raw textarea here so we don't depend on the
    // blur having fired (clicking Continue can race the textarea's onBlur).
    const parsedConstraints = constraintsText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const briefWithAssets = {
      ...brief,
      constraints: parsedConstraints,
      ...(logoUrl ? { logoUrl } : {}),
      ...(inspirationImages.length > 0 ? { inspirationImages } : {}),
    };
    setBrief({ ...brief, constraints: parsedConstraints });
    try {
      // Adopt the interview's business name as the site name so the wordmark
      // (header + footer) reflects the brand, not the placeholder name set at
      // signup. site.name is what the public render uses for both, so this is
      // what keeps the two in sync after generation.
      const businessName = brief.businessName?.trim();
      await site.update(siteId, {
        brief: briefWithAssets,
        ...(businessName ? { name: businessName } : {}),
      });
      if (logoUrl) {
        await site.update(siteId, { settings: { logoUrl } });
      }
    } catch {
      // Continue even if save fails — brief is still in state
    }
    setSaving(false);
    onContinue();
  };

  return (
    <div>
      <p style={{ color: "var(--color-text-muted)", marginBottom: "1rem" }}>
        Review and edit your site brief before we generate your starter content.
      </p>
      <div className="brief-form">
        <div className="form-group">
          <label>Logo</label>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleLogoUpload}
            style={{ display: "none" }}
          />
          {logoUrl ? (
            <div className="review-logo-preview">
              <img src={logoUrl} alt="Logo" />
              <div className="review-logo-actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading || generatingLogo}
                >
                  Change
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={handleLogoGenerate}
                  disabled={uploading || generatingLogo}
                >
                  {generatingLogo ? "Generating…" : "Re-roll with AI"}
                </button>
                <button
                  type="button"
                  className="btn btn-sm danger"
                  onClick={() => onLogoChange(undefined)}
                  disabled={generatingLogo}
                >
                  Remove
                </button>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading || generatingLogo}
              >
                {uploading ? "Uploading..." : "Upload Logo"}
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={handleLogoGenerate}
                disabled={uploading || generatingLogo}
              >
                {generatingLogo ? "Generating…" : "Generate with AI"}
              </button>
            </div>
          )}
          {logoError && (
            <p style={{ fontSize: "0.8rem", color: "#dc2626", margin: "0.4rem 0 0" }}>{logoError}</p>
          )}
          <p style={{ fontSize: "0.8rem", color: "var(--color-text-muted)", margin: "0.4rem 0 0" }}>
            AI generates a simple brand icon (no lettering). You can always upload your own.
          </p>
        </div>
        <div className="form-group">
          <label>Design Inspiration (optional)</label>
          <p style={{ fontSize: "0.8rem", color: "var(--color-text-muted)", margin: "0 0 0.5rem" }}>
            Upload screenshots of websites or designs you like. We'll analyze them to match your site's style. The images will not be included in your new site directly.
          </p>
          <input
            ref={inspirationInputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={handleInspirationUpload}
            style={{ display: "none" }}
          />
          {inspirationImages.length > 0 && (
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.5rem" }}>
              {inspirationImages.map((url, i) => (
                <div key={i} style={{ position: "relative" }}>
                  <img
                    src={url}
                    alt={`Inspiration ${i + 1}`}
                    style={{ width: "80px", height: "80px", objectFit: "cover", borderRadius: "6px", border: "1px solid var(--color-border)" }}
                  />
                  <button
                    type="button"
                    onClick={() => onInspirationChange(inspirationImages.filter((_, j) => j !== i))}
                    style={{
                      position: "absolute",
                      top: "-6px",
                      right: "-6px",
                      width: "20px",
                      height: "20px",
                      borderRadius: "50%",
                      border: "none",
                      background: "#dc2626",
                      color: "#fff",
                      fontSize: "12px",
                      lineHeight: "20px",
                      textAlign: "center",
                      cursor: "pointer",
                      padding: 0,
                    }}
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>
          )}
          {inspirationImages.length < 5 && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => inspirationInputRef.current?.click()}
              disabled={uploadingInspiration}
            >
              {uploadingInspiration ? "Uploading..." : `Add Image${inspirationImages.length > 0 ? "" : "s"}`}
            </button>
          )}
          {inspirationImages.length >= 5 && (
            <p style={{ fontSize: "0.8rem", color: "var(--color-text-muted)" }}>Maximum 5 images reached.</p>
          )}
        </div>
        <div className="form-group">
          <label>Business Name *</label>
          <input
            type="text"
            value={brief.businessName}
            onChange={(e) => update("businessName", e.target.value)}
          />
        </div>
        <div className="form-group">
          <label>Business Description *</label>
          <textarea
            rows={3}
            value={brief.businessDescription}
            onChange={(e) => update("businessDescription", e.target.value)}
          />
        </div>
        <div className="form-group">
          <label>Location</label>
          <input
            type="text"
            value={brief.location ?? ""}
            onChange={(e) => update("location", e.target.value)}
          />
        </div>
        <div className="form-group">
          <label>Target Audience</label>
          <input
            type="text"
            value={brief.targetAudience ?? ""}
            onChange={(e) => update("targetAudience", e.target.value)}
          />
        </div>
        <div className="form-group">
          <label>Differentiators</label>
          <textarea
            rows={2}
            value={brief.differentiators ?? ""}
            onChange={(e) => update("differentiators", e.target.value)}
          />
        </div>
        <div className="form-group">
          <label>Tone</label>
          <input
            type="text"
            value={brief.tone ?? ""}
            onChange={(e) => update("tone", e.target.value)}
            placeholder="e.g. Professional, Friendly, Bold"
          />
        </div>
        <div className="form-group">
          <label>Brand Colors</label>
          <input
            type="text"
            value={brief.brandColors ?? ""}
            onChange={(e) => update("brandColors", e.target.value)}
            placeholder="e.g. Navy blue and orange, #1a365d, forest green"
          />
        </div>
        <div className="form-group">
          <label>Primary Goal</label>
          <input
            type="text"
            value={brief.primaryGoal ?? ""}
            onChange={(e) => update("primaryGoal", e.target.value)}
            placeholder="e.g. Generate leads, Sell products, Bookings"
          />
        </div>
        <div className="form-group">
          <label>Must / Must-not (one per line)</label>
          <textarea
            value={constraintsText}
            onChange={(e) => setConstraintsText(e.target.value)}
            onBlur={() =>
              setBrief({
                ...brief,
                constraints: constraintsText
                  .split("\n")
                  .map((line) => line.trim())
                  .filter(Boolean),
              })
            }
            placeholder={"e.g. Do not use stock photos\nNever add a testimonials section\nAlways show the phone number in the header"}
            rows={3}
          />
          <p style={{ fontSize: "0.85rem", color: "var(--color-text-muted)", margin: "0.25rem 0 0" }}>
            Hard rules the design must follow. We pull these from your brief — edit or add any we missed.
          </p>
        </div>
        <div className="form-group">
          <label>Planned Pages ({brief.pages?.length ?? 0})</label>
          {brief.pages && brief.pages.length > 0 ? (
            <ul className="planned-pages-list">
              {brief.pages.map((p, i) => (
                <li key={i} className="planned-page-item">
                  <div className="planned-page-info">
                    <strong>{p.type.charAt(0).toUpperCase() + p.type.slice(1)}</strong>
                    {p.purpose && <span> — {p.purpose}</span>}
                  </div>
                  <button
                    type="button"
                    className="planned-page-remove"
                    onClick={() => {
                      const updated = brief.pages!.filter((_, j) => j !== i);
                      setBrief({ ...brief, pages: updated });
                    }}
                    title="Remove page"
                  >
                    &times;
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p style={{ fontSize: "0.85rem", color: "var(--color-text-muted)" }}>
              No pages planned. Add at least one page below, or defaults will be used (Home + About).
            </p>
          )}
          <AddPageRow
            onAdd={(page) => {
              setBrief({ ...brief, pages: [...(brief.pages ?? []), page] });
            }}
          />
        </div>
        <div className="review-buttons">
          <button
            className="btn btn-full"
            onClick={onBack}
            disabled={saving}
          >
            Back
          </button>
          <button
            className="btn btn-primary btn-full"
            onClick={handleContinue}
            disabled={saving || !brief.businessName || !brief.businessDescription}
          >
            {saving ? "Saving..." : "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3: Generate & Launch
// ---------------------------------------------------------------------------

const PATIENCE_MESSAGES = [
  "Your homepage generation will take longer than additional pages, since we have to create the theme styles first. Other pages will reuse the same styling to make sure the whole site is consistent.",
  "Most agency websites take 6 \u2013 12 weeks to complete, but yours only will be done in a matter of minutes!",
  "For each page, we create a design mockup, then convert it to reusable blocks that are easy to edit later on.",
  "We\u2019re crafting unique content tailored to your business \u2014 no cookie-cutter templates here.",
  "Your site is being optimized for search engines right out of the gate.",
  "Every section is built with conversion in mind \u2014 headlines, CTAs, and layout all working together.",
  "Fun fact: the average small business spends $5,000\u2013$10,000 on a new website. You can redesign yours anytime!",
];

const DEFAULT_PAGES: SiteBriefPage[] = [
  { type: "homepage", slug: "home", purpose: "Main landing page" },
  { type: "about", slug: "about", purpose: "About the business" },
];

function GenerateStep({
  brief,
  siteId,
  onLaunch,
  debugMode,
}: {
  brief: SiteBrief;
  siteId: string;
  onLaunch: () => void;
  debugMode: boolean;
}) {
  const pagesToGenerate = brief.pages?.length ? brief.pages : DEFAULT_PAGES;
  const totalPages = pagesToGenerate.length;
  const [currentIndex, setCurrentIndex] = useState(0);
  const [status, setStatus] = useState("");
  const [createdPages, setCreatedPages] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [subdomain, setSubdomain] = useState<string | null>(null);
  const started = useRef(false);
  const [patienceIndex, setPatienceIndex] = useState(0);
  const [ticks, setTicks] = useState(0);

  // Per-page generation takes minutes, so instead of sitting on the
  // last boundary the whole time, tick progress up by 1% every 30s while
  // the current page is working. Cap 3% below the next page boundary so
  // the jump at completion still feels like progress, not a reset.
  const basePct = (currentIndex / totalPages) * 100;
  const nextPct = ((currentIndex + 1) / totalPages) * 100;
  const cap = Math.max(basePct, nextPct - 3);
  const progress = done
    ? 100
    : Math.min(Math.round(basePct + ticks), Math.floor(cap));

  // Reset the tick counter each time we move to a new page
  useEffect(() => {
    setTicks(0);
  }, [currentIndex]);

  // 1% every 20s while generating
  useEffect(() => {
    if (done) return;
    const interval = setInterval(() => {
      setTicks((t) => t + 1);
    }, 10_000);
    return () => clearInterval(interval);
  }, [done]);

  // Rotate patience messages every 45 seconds
  useEffect(() => {
    if (done) return;
    const interval = setInterval(() => {
      setPatienceIndex((prev) => (prev + 1) % PATIENCE_MESSAGES.length);
    }, 45000);
    return () => clearInterval(interval);
  }, [done]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    generateAllPages();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch subdomain for preview
  useEffect(() => {
    site.get(siteId).then((s) => setSubdomain(s.subdomain)).catch(() => {});
  }, [siteId]);

  async function generateWithStitch(
    pageType: string,
    purpose: string,
    opts?: { skipThemeWrite?: boolean },
    onImagePrompts?: (prompts: Array<{ blockIndex: number; placeholderSrc: string; prompt: string; aspectRatio: string }>) => void,
  ): Promise<unknown[] | null> {
    try {
      const res = await ai.designPage(pageType, purpose, undefined, undefined, { ...opts, ...(debugMode ? { debug: true } : {}) });
      console.log(`Stitch designPage response for ${pageType}:`, res.blocks?.length, "blocks");
      if (debugMode && res.debugHtmlUrl) {
        try {
          const fetchRes = await fetch(res.debugHtmlUrl);
          const blob = await fetchRes.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `design-debug-${Date.now()}.html`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        } catch (dlErr) {
          console.warn('debug HTML download failed:', dlErr);
        }
      }
      // Stitch occasionally returns 0 blocks when the import extractor finds
      // no top-level content. Treat that as a failure so we fall back to the
      // legacy generator instead of writing an empty page.
      if (!res.blocks || res.blocks.length === 0) {
        console.warn(`Stitch designPage returned 0 blocks for ${pageType} — falling back to legacy generator`);
        return null;
      }
      if (res.imagePrompts?.length && onImagePrompts) {
        onImagePrompts(res.imagePrompts);
      }
      return res.blocks;
    } catch (err) {
      console.error(`Stitch designPage failed for ${pageType} — falling back to legacy generator:`, err);
      return null;
    }
  }

  async function generateFallbackBlocks(page: SiteBriefPage): Promise<unknown[]> {
    const isHome = page.slug === "home" || page.type === "homepage";

    const prompt = isHome
      ? `Create website homepage content for: ${brief.businessName} — ${brief.businessDescription}.
${brief.targetAudience ? `Target audience: ${brief.targetAudience}.` : ""}
${brief.primaryGoal ? `Primary goal: ${brief.primaryGoal}.` : ""}
${brief.tone ? `Tone: ${brief.tone}.` : ""}

Return ONLY valid JSON (no markdown fences) with this structure:
{
  "headline": "Main hero headline",
  "subheadline": "Supporting text under headline",
  "ctaText": "Call to action button text",
  "sections": [
    { "heading": "Section heading", "body": "Section paragraph text" }
  ]
}`
      : `Write a "${page.type}" page for: ${brief.businessName} — ${brief.businessDescription}.
Page purpose: ${page.purpose}
${brief.differentiators ? `What makes them special: ${brief.differentiators}.` : ""}
${brief.tone ? `Tone: ${brief.tone}.` : ""}

Return ONLY valid JSON (no markdown fences):
{
  "heading": "Page heading",
  "sections": [
    { "heading": "Section heading", "body": "Section paragraph text (can be multiple paragraphs)" }
  ]
}`;

    const res = await ai.generate(prompt, "copywriting");
    let data: Record<string, unknown> = {};
    try {
      let text = res.text.trim();
      const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fence) text = fence[1].trim();
      data = JSON.parse(text);
    } catch {
      // Fallback structure
    }

    if (isHome) {
      return [
        {
          blockType: "hero",
          data: {
            headline: data.headline ?? `Welcome to ${brief.businessName}`,
            subheadline: data.subheadline ?? brief.businessDescription,
            ctaText: data.ctaText ?? "Get Started",
          },
        },
        ...((data.sections as Array<{ heading: string; body: string }>) ?? []).map(
          (s) => ({ blockType: "section", data: { heading: s.heading, body: s.body } })
        ),
      ];
    }

    const pageTitle = data.heading ?? `${page.type.charAt(0).toUpperCase() + page.type.slice(1)}`;
    const sections = (data.sections as Array<{ heading: string; body: string }>) ?? [];

    return [
      { blockType: "heading", data: { text: pageTitle } },
      ...sections.flatMap((s) => [
        { blockType: "heading", data: { text: s.heading, level: 2 } },
        { blockType: "paragraph", data: { text: s.body } },
      ]),
      // If no sections were generated, add a placeholder paragraph
      ...(sections.length === 0
        ? [{ blockType: "paragraph", data: { text: page.purpose } }]
        : []),
    ];
  }

  async function generateOnePage(
    page: SiteBriefPage,
    opts: { skipThemeWrite: boolean },
  ): Promise<string | null> {
    const label = page.type.charAt(0).toUpperCase() + page.type.slice(1);
    const isBlog = page.type === "blog" || page.type === "blog-index";

    try {
      if (isBlog) {
        // Generate the blog index page as a normal page
        let blocks = await generateWithStitch(page.type, page.purpose, { skipThemeWrite: opts.skipThemeWrite });
        if (!blocks) blocks = await generateFallbackBlocks(page);
        await content.create({
          type: "page",
          slug: page.slug,
          status: "published",
          schemaData: { title: `Blog — ${brief.businessName}` },
          blocks,
          skipRecompile: true,
        });
        // Also generate the post template (fire-and-forget — don't let it block)
        ai.designPage(
          "blog-post",
          "Blog post template — layout for individual blog posts with title, date, featured image, and article content. Should match the site's design system.",
          undefined,
          "post-template",
          { skipThemeWrite: true, ...(debugMode ? { debug: true } : {}) },
        ).catch((err) => console.error("Blog post template generation failed:", err));
        return label;
      }

      let pendingImagePrompts: Array<{ blockIndex: number; placeholderSrc: string; prompt: string; aspectRatio: string }> | undefined;

      let blocks = await generateWithStitch(
        page.type,
        page.purpose,
        { skipThemeWrite: opts.skipThemeWrite },
        (prompts) => { pendingImagePrompts = prompts; },
      );
      if (!blocks) {
        blocks = await generateFallbackBlocks(page);
      }

      const isHome = page.slug === "home" || page.type === "homepage";
      const savedContent = await content.create({
        type: "page",
        slug: page.slug,
        status: "published",
        schemaData: {
          title: isHome ? brief.businessName : `${label} — ${brief.businessName}`,
          ...(isHome ? { description: brief.businessDescription } : {}),
        },
        blocks,
        // Onboarding does one final recompile after all pages settle, so
        // each per-page write skips the redundant compile.
        skipRecompile: true,
      });
      // Fire-and-forget: generate real images to replace placeholders
      if (pendingImagePrompts?.length && savedContent?.id) {
        ai.enqueuePageImages(savedContent.id, pendingImagePrompts).catch(() => {});
      }
      return label;
    } catch (err) {
      console.error(`Onboarding: failed to generate ${page.type} page (${page.slug}):`, err);
      return null;
    }
  }

  async function generateAllPages() {
    // Homepage must finish first — it bootstraps the Stitch projectId and the
    // site theme (colors, fonts, header/footer). Subsequent pages can then
    // run in parallel because they reuse the same projectId and skip theme
    // writes (existing theme always wins anyway).
    const homepageIdx = pagesToGenerate.findIndex(
      (p) => p.type === "homepage" || p.slug === "home",
    );
    const homeFirst = homepageIdx === -1 ? 0 : homepageIdx;
    const home = pagesToGenerate[homeFirst];
    const rest = pagesToGenerate.filter((_, i) => i !== homeFirst);

    const created: string[] = [];
    let completed = 0;

    setCurrentIndex(0);
    setStatus(`Generating ${home.type.charAt(0).toUpperCase() + home.type.slice(1)} page...`);
    const homeLabel = await generateOnePage(home, { skipThemeWrite: false });
    completed += 1;
    setCurrentIndex(completed);
    if (homeLabel) {
      created.push(homeLabel);
      setCreatedPages([...created]);
    }

    if (rest.length > 0) {
      setStatus(`Generating ${rest.length} page${rest.length === 1 ? "" : "s"} in parallel...`);
      await Promise.all(
        rest.map(async (page) => {
          const label = await generateOnePage(page, { skipThemeWrite: true });
          completed += 1;
          setCurrentIndex(completed);
          if (label) {
            created.push(label);
            setCreatedPages([...created]);
          }
        }),
      );
    }

    // One final theme compile that covers every block from every page.
    if (created.length > 0) {
      setStatus("Finalizing site styles...");
      try {
        await site.recompileCss(siteId);
      } catch {
        // CSS will fall back to Tailwind CDN if compile fails — non-fatal.
      }
    }

    // Create navigation from generated pages
    if (created.length > 0) {
      try {
        const navItems = pagesToGenerate
          .filter((p) => {
            const label = p.type.charAt(0).toUpperCase() + p.type.slice(1);
            return created.includes(label);
          })
          .map((p) => ({
            label: p.type.charAt(0).toUpperCase() + p.type.slice(1),
            url: p.slug === "home" ? "/" : `/${p.slug}`,
          }));
        await navigation.upsert("header", navItems);
      } catch {
        // Navigation is non-critical — site still works without it
      }
    }

    setDone(true);
    setStatus(created.length > 0 ? "Your site is ready!" : "Ready to launch!");
  }

  const baseDomain = import.meta.env.VITE_BASE_DOMAIN || "cadmus.digital";
  // Dev uses {subdomain}--dev.cadmus.digital to stay under *.cadmus.digital wildcard cert
  const siteUrl = subdomain
    ? baseDomain === "cadmus.digital"
      ? `https://${subdomain}.cadmus.digital`
      : `https://${subdomain}--dev.cadmus.digital`
    : null;

  const handleLaunch = async () => {
    setLaunching(true);
    onLaunch();
  };

  return (
    <div className="generate-status">
      {!done && (
        <>
          <div className="generate-spinner" />
          <p>{status}</p>
          <div className="generate-progress-bar">
            <div
              className="generate-progress-fill"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="generate-progress-label">{progress}% — {currentIndex} of {totalPages} pages</p>
          <p className="generate-patience">{PATIENCE_MESSAGES[patienceIndex]}</p>
          {createdPages.length > 0 && (
            <div className="generated-summary">
              <ul>
                {createdPages.map((p) => (
                  <li key={p}>
                    <span className="check-icon">{"\u2713"}</span> {p}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {done && createdPages.length > 0 && (
        <div className="generated-summary">
          <h4>Created {createdPages.length} pages:</h4>
          <ul>
            {createdPages.map((p) => (
              <li key={p}>
                <span className="check-icon">{"\u2713"}</span> {p}
              </li>
            ))}
          </ul>
        </div>
      )}

      {done && siteUrl && (
        <div className="site-preview-wrapper">
          <iframe
            className="site-preview-frame"
            src={siteUrl}
            title="Site preview"
          />
        </div>
      )}

      {done && (
        <div className="launch-actions">
          {siteUrl && (
            <a
              href={siteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-primary"
            >
              View Your Site
            </a>
          )}
          <button
            className="btn btn-primary"
            onClick={handleLaunch}
            disabled={launching}
          >
            {launching ? "Launching..." : "Go to Dashboard"}
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Onboarding Wizard
// ---------------------------------------------------------------------------

export function Onboarding() {
  const { user, siteStatus, refreshSiteStatus } = useAuth();
  const navigate = useNavigate();
  const debugMode = new URLSearchParams(window.location.search).get('debug') === 'true';
  const [step, setStep] = useState<OnboardingStep>("choose");
  const [reviewBackStep, setReviewBackStep] = useState<OnboardingStep>("interview");
  const [briefPasteText, setBriefPasteText] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [brief, setBrief] = useState<SiteBrief>({
    businessName: "",
    businessDescription: "",
  });
  const [logoUrl, setLogoUrl] = useState<string | undefined>();
  const [inspirationImages, setInspirationImages] = useState<string[]>([]);
  const briefPromiseRef = useRef<Promise<any> | null>(null);

  if (!user) return <Navigate to="/login" state={{ returnTo: "/onboarding" + window.location.search }} replace />;
  if (!user.emailVerifiedAt) return <Navigate to="/verify-email" replace />;
  if (siteStatus === "active") return <Navigate to="/" replace />;

  const handleInterviewComplete = async (_msgs: Message[]) => {
    // Brief extraction was kicked off when the countdown started — await it
    try {
      const res = await (briefPromiseRef.current ?? ai.extractBrief(_msgs));
      const extractedPages: SiteBriefPage[] = Array.isArray(res.brief.pages)
        ? (res.brief.pages as unknown as SiteBriefPage[])
        : [
            { type: "homepage", slug: "home", purpose: "Main landing page" },
            { type: "about", slug: "about", purpose: "About the business" },
          ];
      setBrief({
        businessName: res.brief.businessName ?? "",
        businessDescription: res.brief.businessDescription ?? "",
        location: res.brief.location ?? undefined,
        targetAudience: res.brief.targetAudience ?? undefined,
        differentiators: res.brief.differentiators ?? undefined,
        tone: res.brief.tone ?? undefined,
        primaryGoal: res.brief.primaryGoal ?? undefined,
        brandColors: res.brief.brandColors ?? undefined,
        constraints: res.brief.constraints ?? undefined,
        pages: extractedPages,
      });
    } catch {
      // Advance with empty brief — user can fill in manually
    }
    setReviewBackStep("interview");
    setStep("review");
  };

  const handleBriefPasteComplete = (parsed: SiteBrief) => {
    setBrief(parsed);
    setReviewBackStep("brief-paste");
    setStep("review");
  };

  const handleLaunch = async () => {
    const promoCode = localStorage.getItem("cadmus_promo") ?? undefined;
    try {
      await site.activate(user!.siteId, promoCode);
      localStorage.removeItem("cadmus_promo");
      await refreshSiteStatus();
    } catch {
      // Still navigate — activation may have partially succeeded
    }
    navigate("/");
  };

  const handleSkip = async () => {
    const promoCode = localStorage.getItem("cadmus_promo") ?? undefined;
    try {
      // Save a minimal brief so the site has a name
      await site.update(user!.siteId, {
        name: user!.email.split("@")[0] + "'s Site",
        settings: { skippedOnboarding: true },
      });
      // Create a default home page if none exists
      const existing = await content.list("page");
      if (existing.total === 0) {
        await content.create({
          type: "page",
          slug: "home",
          status: "published",
          schemaData: { title: "Home", description: "Welcome to your new site." },
          blocks: [
            {
              blockType: "hero",
              data: {
                heading: "Welcome",
                subheading: "Your site is ready. Head to Settings to customize your theme, or use the AI assistant to generate content.",
              },
            },
          ],
        });
      }
      await site.activate(user!.siteId, promoCode);
      localStorage.removeItem("cadmus_promo");
      await refreshSiteStatus();
    } catch {
      // Still navigate
    }
    navigate("/");
  };

  const subtitleText = () => {
    if (step === "choose") return "How would you like to set up your site?";
    if (step === "brief-paste") return "Paste your brief or copy below.";
    if (step === "interview") return "Answer a few questions so we can build your website. The more detailed your answers, the better your site will be!";
    if (step === "review") return "Review your site brief.";
    if (step === "launch") return "Generating your starter content.";
    return "";
  };

  return (
    <div className="auth-page">
      <div className="onboarding-card">
        <h2>Set up your site</h2>
        <p className="subtitle">{subtitleText()}</p>

        <StepIndicator step={step} />

        {step === "choose" && (
          <>
            <ChooseStep
              onChooseInterview={() => setStep("interview")}
              onChooseBrief={() => setStep("brief-paste")}
            />
            <div style={{ textAlign: "center", marginTop: "1.5rem" }}>
              <button
                type="button"
                onClick={handleSkip}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--color-text-muted, #6b7280)",
                  fontSize: "0.875rem",
                  cursor: "pointer",
                  textDecoration: "underline",
                  padding: "0.5rem",
                }}
              >
                Skip for now — I'll set things up later
              </button>
            </div>
          </>
        )}

        {step === "brief-paste" && (
          <BriefPasteStep
            onComplete={handleBriefPasteComplete}
            onBack={() => setStep("choose")}
            text={briefPasteText}
            onTextChange={setBriefPasteText}
          />
        )}

        {step === "interview" && (
          <>
            <InterviewStep
              messages={messages}
              setMessages={setMessages}
              onComplete={handleInterviewComplete}
              logoUrl={logoUrl}
              onLogoChange={setLogoUrl}
              briefPromiseRef={briefPromiseRef}
            />
            <div style={{ textAlign: "center", marginTop: "1rem" }}>
              <button
                type="button"
                onClick={() => setStep("choose")}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--color-text-muted, #6b7280)",
                  fontSize: "0.875rem",
                  cursor: "pointer",
                  textDecoration: "underline",
                  padding: "0.5rem",
                }}
              >
                ← Back to options
              </button>
            </div>
          </>
        )}

        {step === "review" && (
          <ReviewStep
            brief={brief}
            setBrief={setBrief}
            siteId={user!.siteId}
            onContinue={() => setStep("launch")}
            onBack={() => setStep(reviewBackStep)}
            logoUrl={logoUrl}
            onLogoChange={setLogoUrl}
            inspirationImages={inspirationImages}
            onInspirationChange={setInspirationImages}
          />
        )}

        {step === "launch" && (
          <GenerateStep
            brief={brief}
            siteId={user!.siteId}
            onLaunch={handleLaunch}
            debugMode={debugMode}
          />
        )}
      </div>
    </div>
  );
}
