import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useAuth } from "../context/AuthContext";
import { site, ai, media } from "../lib/api";

interface SiteData {
  id: string;
  settings?: Record<string, unknown>;
}

async function validateFaviconFile(file: File, t: TFunction): Promise<string | null> {
  const allowed = ["image/png", "image/svg+xml", "image/x-icon", "image/vnd.microsoft.icon"];
  if (!allowed.includes(file.type)) {
    return t("branding.favicon.errors.invalidType");
  }
  // SVGs are vector, no dimension check needed
  if (file.type === "image/svg+xml") return null;
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      if (img.naturalWidth !== img.naturalHeight) {
        resolve(t("branding.favicon.errors.mustBeSquare"));
      } else if (img.naturalWidth < 256) {
        resolve(t("branding.favicon.errors.tooSmall"));
      } else {
        resolve(null);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(t("branding.favicon.errors.readFailed"));
    };
    img.src = url;
  });
}

/**
 * Branding controls for the public site: the "Powered by Cadmus" footer byline
 * and the favicon. Self-contained — fetches its own site and persists via
 * `site.update`. Rendered on the Style page.
 */
export function BrandingSection() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [siteData, setSiteData] = useState<SiteData | null>(null);

  // Byline
  const [showCadmusByline, setShowCadmusByline] = useState(true);
  const [brandingSaved, setBrandingSaved] = useState(false);
  const [brandingError, setBrandingError] = useState("");

  // Favicon
  const [faviconUrl, setFaviconUrl] = useState("");
  const [faviconPreview, setFaviconPreview] = useState("");
  const [faviconError, setFaviconError] = useState("");
  const [faviconSaved, setFaviconSaved] = useState(false);
  const [faviconGenerating, setFaviconGenerating] = useState(false);
  const [faviconUploading, setFaviconUploading] = useState(false);
  const [faviconSaving, setFaviconSaving] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const s = (await site.get(user.siteId)) as SiteData;
      setSiteData(s);
      const settings = s.settings as Record<string, unknown> | undefined;
      setShowCadmusByline(settings?.hideCadmusByline !== true);
      setFaviconUrl((settings?.faviconUrl as string) || "");
    } catch {
      // ignore
    }
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  const handleFaviconUpload = async (file: File) => {
    setFaviconError("");
    setFaviconSaved(false);
    const validationError = await validateFaviconFile(file, t);
    if (validationError) {
      setFaviconError(validationError);
      return;
    }
    setFaviconUploading(true);
    try {
      const result = await media.upload(file, user?.id);
      const url = (result as { storageUrl?: string }).storageUrl;
      if (!url) throw new Error(t("branding.favicon.errors.uploadNoUrl"));
      setFaviconPreview(url);
    } catch (e) {
      setFaviconError(e instanceof Error ? e.message : t("branding.favicon.errors.uploadFailed"));
    } finally {
      setFaviconUploading(false);
    }
  };

  const handleFaviconGenerate = async () => {
    setFaviconError("");
    setFaviconSaved(false);
    setFaviconGenerating(true);
    try {
      const result = await ai.generateFavicon();
      setFaviconPreview(result.url);
    } catch (e) {
      setFaviconError(e instanceof Error ? e.message : t("branding.favicon.errors.generationFailed"));
    } finally {
      setFaviconGenerating(false);
    }
  };

  const saveFavicon = async () => {
    if (!siteData || !faviconPreview) return;
    setFaviconError("");
    setFaviconSaving(true);
    try {
      const existingSettings = siteData.settings as Record<string, unknown> | undefined;
      await site.update(siteData.id, {
        settings: { ...existingSettings, faviconUrl: faviconPreview },
      });
      setSiteData({ ...siteData, settings: { ...existingSettings, faviconUrl: faviconPreview } });
      setFaviconUrl(faviconPreview);
      setFaviconPreview("");
      setFaviconSaved(true);
      setTimeout(() => setFaviconSaved(false), 3000);
    } catch (e) {
      setFaviconError(e instanceof Error ? e.message : t("branding.favicon.errors.saveFailed"));
    } finally {
      setFaviconSaving(false);
    }
  };

  const removeFavicon = async () => {
    if (!siteData) return;
    setFaviconError("");
    setFaviconSaving(true);
    try {
      const existingSettings = siteData.settings as Record<string, unknown> | undefined;
      const next = { ...existingSettings };
      delete next.faviconUrl;
      await site.update(siteData.id, { settings: next });
      setSiteData({ ...siteData, settings: next });
      setFaviconUrl("");
      setFaviconPreview("");
      setFaviconSaved(true);
      setTimeout(() => setFaviconSaved(false), 3000);
    } catch (e) {
      setFaviconError(e instanceof Error ? e.message : t("branding.favicon.errors.removeFailed"));
    } finally {
      setFaviconSaving(false);
    }
  };

  return (
    <section className="settings-section">
      <h3>{t("branding.title")}</h3>
      <p style={{ marginBottom: "1rem", fontSize: "0.9rem", color: "var(--color-text-muted)" }}>
        {t("branding.subtitle")}
      </p>
      <div className="settings-form">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={showCadmusByline}
            onChange={(e) => setShowCadmusByline(e.target.checked)}
          />
          <span>{t("branding.bylineLabel")}</span>
        </label>
        <div className="settings-actions">
          <button
            className="btn btn-primary"
            onClick={async () => {
              if (!siteData) return;
              setBrandingError("");
              setBrandingSaved(false);
              try {
                const existingSettings = siteData.settings as Record<string, unknown> | undefined;
                await site.update(siteData.id, {
                  settings: { ...existingSettings, hideCadmusByline: !showCadmusByline },
                });
                setSiteData({ ...siteData, settings: { ...existingSettings, hideCadmusByline: !showCadmusByline } });
                setBrandingSaved(true);
                setTimeout(() => setBrandingSaved(false), 3000);
              } catch (e) {
                setBrandingError(e instanceof Error ? e.message : t("branding.errors.saveFailed"));
              }
            }}
          >
            {t("common.save")}
          </button>
          {brandingSaved && <span className="settings-success">{t("common.saved")}</span>}
          {brandingError && <span className="auth-error">{brandingError}</span>}
        </div>
      </div>

      <hr style={{ margin: "1.5rem 0", border: "none", borderTop: "1px solid var(--color-border)" }} />

      <h4 style={{ marginBottom: "0.5rem" }}>{t("branding.favicon.title")}</h4>
      <p style={{ marginBottom: "1rem", fontSize: "0.9rem", color: "var(--color-text-muted)" }}>
        {t("branding.favicon.subtitle")}
      </p>
      <div className="settings-form">
        <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "0.75rem" }}>
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: 8,
              border: "1px solid var(--color-border)",
              background: "var(--color-bg-subtle, #f5f5f5)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              overflow: "hidden",
            }}
          >
            {(faviconPreview || faviconUrl) ? (
              <img
                src={faviconPreview || faviconUrl}
                alt={t("branding.favicon.imageAlt")}
                style={{ maxWidth: "100%", maxHeight: "100%" }}
              />
            ) : (
              <span style={{ fontSize: "0.75rem", color: "var(--color-text-muted)" }}>{t("branding.favicon.none")}</span>
            )}
          </div>
          <div style={{ fontSize: "0.85rem", color: "var(--color-text-muted)" }}>
            {faviconPreview ? (
              <span>{t("branding.favicon.previewNotSaved")}</span>
            ) : faviconUrl ? (
              <span>{t("branding.favicon.currentFavicon")}</span>
            ) : (
              <span>{t("branding.favicon.usingDefault")}</span>
            )}
          </div>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
          <label
            className="btn btn-secondary"
            style={{
              cursor: faviconUploading ? "wait" : "pointer",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              minWidth: "10rem",
            }}
          >
            {faviconUploading ? t("branding.favicon.uploading") : t("common.upload")}
            <input
              type="file"
              accept="image/png,image/svg+xml,image/x-icon,image/vnd.microsoft.icon,.ico"
              style={{ display: "none" }}
              disabled={faviconUploading || faviconGenerating || faviconSaving}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFaviconUpload(file);
                e.target.value = "";
              }}
            />
          </label>
          <button
            type="button"
            className="btn btn-secondary"
            style={{
              minWidth: "10rem",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            disabled={faviconUploading || faviconGenerating || faviconSaving}
            onClick={handleFaviconGenerate}
          >
            {faviconGenerating ? t("common.generating") : faviconPreview ? t("common.reRollWithAi") : t("common.generateWithAi")}
          </button>
          {faviconPreview && (
            <>
              <button
                type="button"
                className="btn btn-primary"
                disabled={faviconSaving}
                onClick={saveFavicon}
              >
                {faviconSaving ? t("common.saving") : t("common.save")}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={faviconSaving}
                onClick={() => {
                  setFaviconPreview("");
                  setFaviconError("");
                }}
              >
                {t("branding.favicon.discard")}
              </button>
            </>
          )}
          {!faviconPreview && faviconUrl && (
            <button
              type="button"
              className="btn btn-ghost"
              disabled={faviconSaving}
              onClick={removeFavicon}
            >
              {t("common.remove")}
            </button>
          )}
        </div>
        {faviconSaved && <span className="settings-success" style={{ marginTop: "0.5rem" }}>{t("common.saved")}</span>}
        {faviconError && <span className="auth-error" style={{ marginTop: "0.5rem" }}>{faviconError}</span>}
      </div>
    </section>
  );
}
