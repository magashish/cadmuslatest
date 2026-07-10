import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
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
      <h3>{t("designDirection.title")}</h3>
      <p style={{ marginBottom: "0.75rem", fontSize: "0.9rem", color: "var(--color-text-muted)" }}>
        {t("designDirection.intro")}
        {designIntent && (
          <span style={{ display: "block", marginTop: "0.35rem", fontSize: "0.8rem" }}>
            {t("designDirection.versionLabel", { version: designIntent.version })} · {designIntent.source === "generated" ? t("designDirection.source.generated") : designIntent.source === "refined" ? t("designDirection.source.refined") : t("designDirection.source.edited")}
            {designIntent.updatedAt ? ` · ${t("designDirection.updatedOn", { date: new Date(designIntent.updatedAt).toLocaleDateString() })}` : ""}
          </span>
        )}
      </p>
      {!designIntent && (
        <p style={{ marginBottom: "0.75rem", fontSize: "0.85rem", color: "var(--color-text-muted)", fontStyle: "italic" }}>
          {t("designDirection.notCapturedYet")}
        </p>
      )}
      <div className="settings-form">
        <label>
          {t("designDirection.fields.aesthetic.label")} <span style={{ color: "var(--color-text-muted)", fontWeight: 400 }}>{t("designDirection.fields.aesthetic.hint")}</span>
          <textarea value={diAesthetic} onChange={(e) => setDiAesthetic(e.target.value)} rows={2} placeholder={t("designDirection.fields.aesthetic.placeholder")} />
        </label>
        <label>
          {t("designDirection.fields.voice.label")} <span style={{ color: "var(--color-text-muted)", fontWeight: 400 }}>{t("designDirection.fields.voice.hint")}</span>
          <input type="text" value={diVoice} onChange={(e) => setDiVoice(e.target.value)} placeholder={t("designDirection.fields.voice.placeholder")} />
        </label>
        <label>
          {t("designDirection.fields.layout.label")}
          <textarea value={diLayout} onChange={(e) => setDiLayout(e.target.value)} rows={2} placeholder={t("designDirection.fields.layout.placeholder")} />
        </label>
        <label>
          {t("designDirection.fields.imagery.label")} <span style={{ color: "var(--color-text-muted)", fontWeight: 400 }}>{t("designDirection.fields.imagery.hint")}</span>
          <textarea value={diImagery} onChange={(e) => setDiImagery(e.target.value)} rows={2} placeholder={t("designDirection.fields.imagery.placeholder")} />
        </label>
        <label>
          {t("designDirection.fields.colorType.label")}
          <textarea value={diColorType} onChange={(e) => setDiColorType(e.target.value)} rows={2} placeholder={t("designDirection.fields.colorType.placeholder")} />
        </label>
        <label>
          {t("designDirection.fields.positioning.label")} <span style={{ color: "var(--color-text-muted)", fontWeight: 400 }}>{t("designDirection.fields.positioning.hint")}</span>
          <input type="text" value={diPositioning} onChange={(e) => setDiPositioning(e.target.value)} placeholder={t("designDirection.fields.positioning.placeholder")} />
        </label>
        <label>
          {t("designDirection.fields.constraints.label")} <span style={{ color: "var(--color-text-muted)", fontWeight: 400 }}>{t("designDirection.fields.constraints.hint")}</span>
          <textarea value={diConstraints} onChange={(e) => setDiConstraints(e.target.value)} rows={3} placeholder={t("designDirection.fields.constraints.placeholder")} style={{ fontFamily: "ui-monospace, monospace", fontSize: "0.8rem" }} />
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
                setDiError(e instanceof Error ? e.message : t("designDirection.errors.saveFailed"));
              } finally {
                setDiSaving(false);
              }
            }}
          >
            {diSaving ? t("common.saving") : t("designDirection.saveButton")}
          </button>
          {diSaved && <span className="settings-success">{t("common.saved")}</span>}
          {diError && <span className="auth-error">{diError}</span>}
        </div>
      </div>
    </section>
  );
}
