import { useState, useEffect, useCallback } from "react";
import { useAuth } from "../context/AuthContext";
import { seo, type SeoFiles } from "../lib/api";

export function SEO() {
  const { user, sitePlan } = useAuth();
  const [data, setData] = useState<SeoFiles | null>(null);
  const [loading, setLoading] = useState(true);
  const [llmsText, setLlmsText] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState("");

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const res = await seo.get(user.siteId);
      setData(res);
      setLlmsText(res.llms.override ?? res.llms.generated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load SEO settings");
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  // Free-tier sites are noindex — the SEO files don't apply.
  if (sitePlan === "free") {
    return (
      <div className="page">
        <h2>SEO</h2>
        <section className="settings-section">
          <p>
            SEO files (<code>llms.txt</code>, <code>sitemap.xml</code>, <code>robots.txt</code>) are
            available on paid plans. Free-tier sites are set to <strong>no-index</strong>, so search
            engines and AI assistants are asked not to list them. Upgrade to manage these.
          </p>
        </section>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="page">
        <h2>SEO</h2>
        <p>Loading...</p>
      </div>
    );
  }

  const usingOverride = !!data?.llms.override;

  const handleSave = async () => {
    if (!user) return;
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      await seo.saveLlms(user.siteId, llmsText);
      await load();
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (!user || !data) return;
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      await seo.saveLlms(user.siteId, null);
      setLlmsText(data.llms.generated);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to reset");
    } finally {
      setSaving(false);
    }
  };

  const handleDraft = async () => {
    if (!user) return;
    setDrafting(true);
    setDraftError("");
    try {
      const res = await seo.draftLlms(user.siteId);
      setLlmsText(res.draft);
    } catch (e) {
      setDraftError(e instanceof Error ? e.message : "Failed to draft with AI");
    } finally {
      setDrafting(false);
    }
  };

  return (
    <div className="page">
      <h2>SEO</h2>

      {/* llms.txt */}
      <section className="settings-section">
        <h3>
          llms.txt{" "}
          <span style={{ fontSize: "0.75rem", color: "#6b7280", fontWeight: 400 }}>
            {usingOverride ? "· custom" : "· auto-generated"}
          </span>
        </h3>
        <p style={{ color: "#6b7280", fontSize: "0.875rem", marginTop: 0 }}>
          A curated guide that helps AI assistants understand your site (
          <a href="https://llmstxt.org" target="_blank" rel="noopener noreferrer">
            llmstxt.org
          </a>
          ). Generated from your site brief and published pages. Edit it or have AI write a richer
          version — leave it untouched to keep it in sync automatically.
        </p>

        <textarea
          value={llmsText}
          onChange={(e) => setLlmsText(e.target.value)}
          spellCheck={false}
          rows={18}
          style={{
            width: "100%",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: "0.8125rem",
            lineHeight: 1.5,
            padding: "0.75rem",
            border: "1px solid #d1d5db",
            borderRadius: 6,
            resize: "vertical",
          }}
        />

        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginTop: "0.75rem", flexWrap: "wrap" }}>
          <button type="button" className="btn" onClick={handleDraft} disabled={drafting || saving}>
            {drafting ? "Writing…" : "Write with AI"}
          </button>
          <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving || drafting}>
            {saving ? "Saving…" : "Save"}
          </button>
          <button type="button" className="btn" onClick={handleReset} disabled={!usingOverride || saving || drafting}>
            Reset to auto
          </button>
          <a href={data?.llms.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: "0.875rem" }}>
            View ↗
          </a>
          {saved && <span style={{ color: "#16a34a", fontSize: "0.875rem" }}>Saved</span>}
          {error && <span style={{ color: "#dc2626", fontSize: "0.875rem" }}>{error}</span>}
          {draftError && <span style={{ color: "#dc2626", fontSize: "0.875rem" }}>{draftError}</span>}
        </div>
      </section>

      {/* sitemap.xml */}
      <section className="settings-section">
        <h3>sitemap.xml</h3>
        <p style={{ color: "#6b7280", fontSize: "0.875rem", marginTop: 0 }}>
          Auto-generated from your published pages and posts. Submitted to search engines via
          robots.txt.
        </p>
        <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
          <a href={data?.sitemap.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: "0.875rem" }}>
            View ↗
          </a>
          <span style={{ color: "#6b7280", fontSize: "0.875rem" }}>
            {data?.sitemap.entryCount} URL{data?.sitemap.entryCount === 1 ? "" : "s"}
          </span>
        </div>
      </section>

      {/* robots.txt */}
      <section className="settings-section">
        <h3>robots.txt</h3>
        <p style={{ color: "#6b7280", fontSize: "0.875rem", marginTop: 0 }}>
          Auto-generated. Allows crawlers and points them to your sitemap.
        </p>
        <a href={data?.robots.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: "0.875rem" }}>
          View ↗
        </a>
      </section>
    </div>
  );
}
