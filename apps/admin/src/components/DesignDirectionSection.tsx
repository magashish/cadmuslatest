import { useState, useEffect, useCallback } from "react";
import { useAuth } from "../context/AuthContext";
import { site } from "../lib/api";
import type { DesignIntent } from "../lib/api";

interface SiteData {
  id: string;
  settings?: Record<string, unknown>;
}

/**
 * Editor for the site's persistent global design direction (design intent). The
 * AI synthesizes this from the homepage and refines it on global chat changes;
 * owners/admins can correct it here. Self-contained — fetches its own site and
 * persists via `site.updateDesignIntent`. Rendered on the Style page.
 */
export function DesignDirectionSection() {
  const { user } = useAuth();
  const [siteData, setSiteData] = useState<SiteData | null>(null);

  const [designIntent, setDesignIntent] = useState<DesignIntent | null>(null);
  const [diAesthetic, setDiAesthetic] = useState("");
  const [diVoice, setDiVoice] = useState("");
  const [diLayout, setDiLayout] = useState("");
  const [diImagery, setDiImagery] = useState("");
  const [diColorType, setDiColorType] = useState("");
  const [diPositioning, setDiPositioning] = useState("");
  const [diConstraints, setDiConstraints] = useState("");
  const [diSaving, setDiSaving] = useState(false);
  const [diSaved, setDiSaved] = useState(false);
  const [diError, setDiError] = useState("");

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const s = (await site.get(user.siteId)) as SiteData;
      setSiteData(s);
      const settings = s.settings as Record<string, unknown> | undefined;
      const di = settings?.designIntent as DesignIntent | undefined;
      if (di) {
        setDesignIntent(di);
        setDiAesthetic(di.aestheticDirection || "");
        setDiVoice(di.voiceAndTone || "");
        setDiLayout(di.layoutPrinciples || "");
        setDiImagery(di.imageryStyle || "");
        setDiColorType(di.colorAndType || "");
        setDiPositioning(di.positioning || "");
        setDiConstraints((di.constraints || []).join("\n"));
      }
    } catch {
      // ignore
    }
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <section className="settings-section">
      <h3>Design Direction</h3>
      <p style={{ marginBottom: "0.75rem", fontSize: "0.9rem", color: "var(--color-text-muted)" }}>
        The AI references this on every edit and new page so your site stays visually and tonally consistent. It's generated from your homepage and evolves as you make global changes in chat — edit it here to correct anything the AI keeps getting wrong.
        {designIntent && (
          <span style={{ display: "block", marginTop: "0.35rem", fontSize: "0.8rem" }}>
            Version {designIntent.version} · {designIntent.source === "generated" ? "auto-generated from homepage" : designIntent.source === "refined" ? "refined via AI chat" : "edited by you"}
            {designIntent.updatedAt ? ` · updated ${new Date(designIntent.updatedAt).toLocaleDateString()}` : ""}
          </span>
        )}
      </p>
      {!designIntent && (
        <p style={{ marginBottom: "0.75rem", fontSize: "0.85rem", color: "var(--color-text-muted)", fontStyle: "italic" }}>
          No design direction has been captured yet — it's synthesized automatically after your homepage is generated. You can also fill it in manually below.
        </p>
      )}
      <div className="settings-form">
        <label>
          Aesthetic direction <span style={{ color: "var(--color-text-muted)", fontWeight: 400 }}>(the overall look in a sentence or two)</span>
          <textarea value={diAesthetic} onChange={(e) => setDiAesthetic(e.target.value)} rows={2} placeholder="e.g. Warm, editorial, and confident — generous whitespace with bold serif headlines over muted earth tones." />
        </label>
        <label>
          Voice &amp; tone <span style={{ color: "var(--color-text-muted)", fontWeight: 400 }}>(how the copy should sound)</span>
          <input type="text" value={diVoice} onChange={(e) => setDiVoice(e.target.value)} placeholder="e.g. Plain-spoken, benefit-led, lightly playful" />
        </label>
        <label>
          Layout &amp; composition
          <textarea value={diLayout} onChange={(e) => setDiLayout(e.target.value)} rows={2} placeholder="e.g. Alternating light/dark sections, asymmetric hero, roomy card grids" />
        </label>
        <label>
          Imagery <span style={{ color: "var(--color-text-muted)", fontWeight: 400 }}>(used to guide AI-generated images)</span>
          <textarea value={diImagery} onChange={(e) => setDiImagery(e.target.value)} rows={2} placeholder="e.g. Natural-light photography, real people, candid moments, no stock-cliché handshakes" />
        </label>
        <label>
          Color &amp; type
          <textarea value={diColorType} onChange={(e) => setDiColorType(e.target.value)} rows={2} placeholder="e.g. Accent reserved for CTAs only; headings in the display serif, body in a clean sans" />
        </label>
        <label>
          Positioning <span style={{ color: "var(--color-text-muted)", fontWeight: 400 }}>(differentiators to reinforce in copy — optional)</span>
          <input type="text" value={diPositioning} onChange={(e) => setDiPositioning(e.target.value)} placeholder="e.g. The only locally-owned option with same-day service" />
        </label>
        <label>
          Constraints <span style={{ color: "var(--color-text-muted)", fontWeight: 400 }}>(hard rules the AI must never break — one per line)</span>
          <textarea value={diConstraints} onChange={(e) => setDiConstraints(e.target.value)} rows={3} placeholder={"e.g. Never use purple\nNo stock photos of offices\nAlways keep the tagline 'Built to last'"} style={{ fontFamily: "ui-monospace, monospace", fontSize: "0.8rem" }} />
        </label>
        <div className="settings-actions">
          <button
            className="btn btn-primary"
            disabled={diSaving || !siteData}
            onClick={async () => {
              if (!siteData) return;
              setDiError("");
              setDiSaved(false);
              setDiSaving(true);
              try {
                const { designIntent: updated } = await site.updateDesignIntent(siteData.id, {
                  aestheticDirection: diAesthetic,
                  voiceAndTone: diVoice,
                  layoutPrinciples: diLayout,
                  imageryStyle: diImagery,
                  colorAndType: diColorType,
                  positioning: diPositioning,
                  constraints: diConstraints.split("\n").map((s) => s.trim()).filter(Boolean),
                });
                setDesignIntent(updated);
                setDiSaved(true);
                setTimeout(() => setDiSaved(false), 3000);
              } catch (e) {
                setDiError(e instanceof Error ? e.message : "Failed to save");
              } finally {
                setDiSaving(false);
              }
            }}
          >
            {diSaving ? "Saving…" : "Save Design Direction"}
          </button>
          {diSaved && <span className="settings-success">Saved!</span>}
          {diError && <span className="auth-error">{diError}</span>}
        </div>
      </div>
    </section>
  );
}
