import { useState, useEffect, useCallback } from "react";
import { useAuth } from "../context/AuthContext";
import { site, ai, media } from "../lib/api";

interface SiteData {
  id: string;
  settings?: Record<string, unknown>;
}

async function validateFaviconFile(file: File): Promise<string | null> {
  const allowed = ["image/png", "image/svg+xml", "image/x-icon", "image/vnd.microsoft.icon"];
  if (!allowed.includes(file.type)) {
    return "Favicon must be a PNG, SVG, or ICO file.";
  }
  // SVGs are vector, no dimension check needed
  if (file.type === "image/svg+xml") return null;
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      if (img.naturalWidth !== img.naturalHeight) {
        resolve("Favicon must be square.");
      } else if (img.naturalWidth < 256) {
        resolve("Favicon must be at least 256×256 pixels.");
      } else {
        resolve(null);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve("Couldn't read image dimensions.");
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
    const validationError = await validateFaviconFile(file);
    if (validationError) {
      setFaviconError(validationError);
      return;
    }
    setFaviconUploading(true);
    try {
      const result = await media.upload(file, user?.id);
      const url = (result as { storageUrl?: string }).storageUrl;
      if (!url) throw new Error("Upload returned no URL");
      setFaviconPreview(url);
    } catch (e) {
      setFaviconError(e instanceof Error ? e.message : "Upload failed");
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
      setFaviconError(e instanceof Error ? e.message : "Generation failed");
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
      setFaviconError(e instanceof Error ? e.message : "Failed to save");
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
      setFaviconError(e instanceof Error ? e.message : "Failed to remove");
    } finally {
      setFaviconSaving(false);
    }
  };

  return (
    <section className="settings-section">
      <h3>Branding</h3>
      <p style={{ marginBottom: "1rem", fontSize: "0.9rem", color: "var(--color-text-muted)" }}>
        Control how Cadmus is credited on your public site.
      </p>
      <div className="settings-form">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={showCadmusByline}
            onChange={(e) => setShowCadmusByline(e.target.checked)}
          />
          <span>Show "Powered by Cadmus" byline in footer</span>
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
                setBrandingError(e instanceof Error ? e.message : "Failed to save");
              }
            }}
          >
            Save
          </button>
          {brandingSaved && <span className="settings-success">Saved!</span>}
          {brandingError && <span className="auth-error">{brandingError}</span>}
        </div>
      </div>

      <hr style={{ margin: "1.5rem 0", border: "none", borderTop: "1px solid var(--color-border)" }} />

      <h4 style={{ marginBottom: "0.5rem" }}>Favicon</h4>
      <p style={{ marginBottom: "1rem", fontSize: "0.9rem", color: "var(--color-text-muted)" }}>
        The small icon shown in browser tabs and bookmarks. Square PNG, SVG, or ICO at least 256×256.
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
                alt="Favicon"
                style={{ maxWidth: "100%", maxHeight: "100%" }}
              />
            ) : (
              <span style={{ fontSize: "0.75rem", color: "var(--color-text-muted)" }}>None</span>
            )}
          </div>
          <div style={{ fontSize: "0.85rem", color: "var(--color-text-muted)" }}>
            {faviconPreview ? (
              <span>Preview — not yet saved.</span>
            ) : faviconUrl ? (
              <span>Current favicon.</span>
            ) : (
              <span>Using the default Cadmus icon.</span>
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
            {faviconUploading ? "Uploading…" : "Upload"}
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
            {faviconGenerating ? "Generating…" : faviconPreview ? "Re-roll with AI" : "Generate with AI"}
          </button>
          {faviconPreview && (
            <>
              <button
                type="button"
                className="btn btn-primary"
                disabled={faviconSaving}
                onClick={saveFavicon}
              >
                {faviconSaving ? "Saving…" : "Save"}
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
                Discard
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
              Remove
            </button>
          )}
        </div>
        {faviconSaved && <span className="settings-success" style={{ marginTop: "0.5rem" }}>Saved!</span>}
        {faviconError && <span className="auth-error" style={{ marginTop: "0.5rem" }}>{faviconError}</span>}
      </div>
    </section>
  );
}
