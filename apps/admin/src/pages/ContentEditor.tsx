import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useNavigate, useSearchParams, useBlocker } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { ContentBlock, ContentType, ContentStatus } from "@cadmus/shared";
import { content, ai, site as siteApi, addons } from "../lib/api";
import { CollectionPicker } from "../components/CollectionPicker";
import { MediaPicker } from "../components/MediaPicker";
import { useAuth } from "../context/AuthContext";
import { BlockEditor } from "../components/editor/BlockEditor";
import "../styles/editor.css";

interface ContentPayload {
  id?: string;
  slug: string;
  type: ContentType;
  status: ContentStatus;
  blocks: ContentBlock[];
}

export function ContentEditor() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isNew = !id;

  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [type, setType] = useState<ContentType>((searchParams.get("type") as ContentType) || "page");
  const [status, setStatus] = useState<ContentStatus>("draft");
  const [blocks, setBlocks] = useState<ContentBlock[]>([]);
  const [metaDescription, setMetaDescription] = useState("");
  const [seoTitle, setSeoTitle] = useState("");
  const [featuredImage, setFeaturedImage] = useState("");
  const [showMediaPicker, setShowMediaPicker] = useState(false);
  const [generatingImage, setGeneratingImage] = useState(false);
  const [imagePrompt, setImagePrompt] = useState("");
  const [showImagePrompt, setShowImagePrompt] = useState(false);
  const [saving, setSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [previewing, setPreviewing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [theme, setTheme] = useState<Record<string, unknown> | undefined>();
  const [installedAddonSlugs, setInstalledAddonSlugs] = useState<string[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [versions, setVersions] = useState<{ version: number; createdAt: string; createdBy?: string | null; authorName?: string | null; schemaData?: Record<string, unknown> }[]>([]);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [restoringVersion, setRestoringVersion] = useState<number | null>(null);

  // Snapshot of saved state to compare against
  const savedState = useRef({ title: "", slug: "", type: "page" as ContentType, status: "draft" as ContentStatus, blocks: [] as ContentBlock[], metaDescription: "", seoTitle: "", featuredImage: "" });
  const justSaved = useRef(false);

  // Browser refresh / tab close
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  // In-app navigation (react-router)
  const blocker = useBlocker(dirty && !justSaved.current);
  useEffect(() => {
    if (blocker.state === "blocked") {
      if (justSaved.current) {
        justSaved.current = false;
        blocker.proceed();
        return;
      }
      const leave = window.confirm(t("contentEditor.unsavedChangesConfirm"));
      if (leave) {
        blocker.proceed();
      } else {
        blocker.reset();
      }
    }
  }, [blocker]);

  const loadContent = useCallback(async () => {
    if (!id) return;
    try {
      setLoading(true);
      const data = (await content.get(id)) as ContentPayload & { schemaData?: Record<string, unknown> };
      const t = (data.schemaData?.title as string) ?? "";
      const md = (data.schemaData?.metaDescription as string) ?? "";
      const st2 = (data.schemaData?.seoTitle as string) ?? "";
      const fi = (data.schemaData?.featuredImage as string) ?? "";
      const s = data.slug ?? "";
      const ty = data.type ?? "page";
      const st = data.status ?? "draft";
      const bl = data.blocks ?? [];
      setTitle(t);
      setMetaDescription(md);
      setSeoTitle(st2);
      setFeaturedImage(fi);
      setSlug(s);
      setType(ty);
      setStatus(st);
      setBlocks(bl);
      savedState.current = { title: t, slug: s, type: ty, status: st, blocks: bl, metaDescription: md, seoTitle: st2, featuredImage: fi };
      setDirty(false);
    } catch (err) {
      setStatusMessage({
        text: t("contentEditor.loadFailed", { message: err instanceof Error ? err.message : t("contentEditor.unknownError") }),
        type: "error",
      });
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadContent();
  }, [loadContent]);

  // Re-fetch content when AI chat actions modify it
  useEffect(() => {
    const handler = () => { if (id) loadContent(); };
    window.addEventListener("cadmus:content-updated", handler);
    return () => window.removeEventListener("cadmus:content-updated", handler);
  }, [id, loadContent]);

  // Fetch site theme from settings for HTML block previews
  useEffect(() => {
    if (!user?.siteId) return;
    siteApi.get(user.siteId).then((s) => {
      const settings = (s as Record<string, unknown>).settings as Record<string, unknown> | undefined;
      if (settings?.theme) {
        setTheme(settings.theme as Record<string, unknown>);
      }
    }).catch(() => {}); // Non-critical
  }, [user?.siteId]);

  // Fetch installed add-ons to gate add-on-backed block types in the picker.
  // Non-blocking: defaults to no add-ons so the editor always renders.
  useEffect(() => {
    addons.list()
      .then((res) => {
        setInstalledAddonSlugs(
          res.items.filter((a) => a.installStatus === "active").map((a) => a.slug)
        );
      })
      .catch(() => {}); // Non-critical
  }, []);

  // Track dirty state by comparing current values against saved snapshot
  useEffect(() => {
    if (loading) return;
    const s = savedState.current;
    const changed =
      title !== s.title ||
      slug !== s.slug ||
      type !== s.type ||
      status !== s.status ||
      metaDescription !== s.metaDescription ||
      featuredImage !== s.featuredImage ||
      blocks !== s.blocks;
    setDirty(changed);
  }, [title, slug, type, status, metaDescription, featuredImage, blocks, loading]);

  const generateSlug = (value: string) => {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  };

  const handleTitleChange = (value: string) => {
    setTitle(value);
    if (isNew || slug === generateSlug(title)) {
      setSlug(generateSlug(value));
    }
  };

  const handleSave = async () => {
    if (!title.trim()) {
      setStatusMessage({ text: t("contentEditor.titleRequired"), type: "error" });
      return;
    }
    if (!slug.trim()) {
      setStatusMessage({ text: t("contentEditor.slugRequired"), type: "error" });
      return;
    }

    setSaving(true);
    setStatusMessage(null);

    const payload = {
      slug,
      type,
      status,
      schemaData: { title, metaDescription: metaDescription || undefined, seoTitle: seoTitle || undefined, featuredImage: featuredImage || undefined },
      blocks,
    };

    try {
      if (isNew) {
        const result = await content.create(payload);
        setStatusMessage({ text: t("contentEditor.createdSuccess"), type: "success" });
        savedState.current = { title, slug, type, status, blocks, metaDescription, seoTitle, featuredImage };
        setDirty(false);
        if (result.id) {
          justSaved.current = true;
          navigate(`/content/${result.id}`, { replace: true });
        }
      } else {
        await content.update(id!, payload);
        setStatusMessage({ text: t("contentEditor.savedSuccess"), type: "success" });
        savedState.current = { title, slug, type, status, blocks, metaDescription, seoTitle, featuredImage };
        setDirty(false);
      }
    } catch (err) {
      setStatusMessage({
        text: t("contentEditor.saveFailed", { message: err instanceof Error ? err.message : t("contentEditor.unknownError") }),
        type: "error",
      });
    } finally {
      setSaving(false);
    }
  };

  const handlePreview = async () => {
    if (!id || !user) return;
    setPreviewing(true);
    try {
      const { previewUrl } = await content.previewUrl(id);

      // Build the site URL from the site's domain or subdomain
      let siteUrl = import.meta.env.VITE_SITE_URL || "";
      if (!siteUrl) {
        const siteData = await siteApi.get(user.siteId);
        const baseDomain = import.meta.env.VITE_BASE_DOMAIN || "cadmus.digital";
        siteUrl = siteData.domain
          ? `https://${siteData.domain}`
          : baseDomain === "cadmus.digital"
            ? `https://${siteData.subdomain}.cadmus.digital`
            : `https://${siteData.subdomain}--dev.cadmus.digital`;
      }

      window.open(`${siteUrl}${previewUrl}`, "_blank");
    } catch (err) {
      setStatusMessage({
        text: t("contentEditor.previewFailed", { message: err instanceof Error ? err.message : t("contentEditor.unknownError") }),
        type: "error",
      });
    } finally {
      setPreviewing(false);
    }
  };

  const handleShowHistory = async () => {
    if (!id) return;
    setShowHistory(true);
    setLoadingVersions(true);
    try {
      const res = await content.versions(id);
      setVersions(res.versions as typeof versions);
    } catch {
      setStatusMessage({ text: t("contentEditor.historyLoadFailed"), type: "error" });
    } finally {
      setLoadingVersions(false);
    }
  };

  const handleRestore = async (version: number) => {
    if (!id || !user) return;
    const confirmed = window.confirm(t("contentEditor.restoreConfirm", { version }));
    if (!confirmed) return;

    setRestoringVersion(version);
    try {
      await content.restore(id, version, user.id);
      await loadContent();
      setShowHistory(false);
      setStatusMessage({ text: t("contentEditor.restoredSuccess", { version }), type: "success" });
    } catch (err) {
      setStatusMessage({
        text: t("contentEditor.restoreFailed", { message: err instanceof Error ? err.message : t("contentEditor.unknownError") }),
        type: "error",
      });
    } finally {
      setRestoringVersion(null);
    }
  };

  const handleGenerateImage = async () => {
    if (!imagePrompt.trim()) return;
    setGeneratingImage(true);
    try {
      const res = await ai.generateImage(imagePrompt, "16:9");
      setFeaturedImage(res.url);
      setShowImagePrompt(false);
      setImagePrompt("");
    } catch (err) {
      setStatusMessage({
        text: t("contentEditor.imageGenFailed", { message: err instanceof Error ? err.message : t("contentEditor.unknownError") }),
        type: "error",
      });
    } finally {
      setGeneratingImage(false);
    }
  };

  if (loading) {
    return (
      <div className="page editor-page">
        <h2>{t("common.loading")}</h2>
      </div>
    );
  }

  return (
    <div className="page editor-page">
      <div className="page-header">
        <h2>{isNew ? t("contentEditor.newTitle") : t("contentEditor.editTitle")}</h2>
        <div className="editor-toolbar-actions">
          {!isNew && (
            <button
              type="button"
              className="btn"
              onClick={handleShowHistory}
            >
              {t("contentEditor.history")}
            </button>
          )}
          {!isNew && (
            <button
              type="button"
              className="btn"
              onClick={handlePreview}
              disabled={previewing}
            >
              {previewing ? t("contentEditor.opening") : t("contentEditor.preview")}
            </button>
          )}
          <button type="button" className="btn" onClick={() => navigate("/content")}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? t("common.saving") : t("common.save")}
          </button>
        </div>
      </div>

      {statusMessage && (
        <div className={`editor-status ${statusMessage.type}`}>
          {statusMessage.text}
        </div>
      )}

      <div className="editor-meta">
        <div className="form-group">
          <label>{t("contentEditor.fields.title")}</label>
          <input
            type="text"
            value={title}
            onChange={(e) => handleTitleChange(e.target.value)}
            placeholder={t("contentEditor.titlePlaceholder")}
          />
        </div>
        <div className="form-group">
          <label>{t("contentEditor.fields.slug")}</label>
          <div style={{ display: "flex", alignItems: "center" }}>
            {type === "post" && (
              <span style={{
                padding: "0 0.5rem",
                background: "var(--color-surface-raised, #f3f4f6)",
                border: "1px solid var(--color-border)",
                borderRight: "none",
                borderRadius: "4px 0 0 4px",
                color: "var(--color-text-secondary)",
                fontSize: "0.875rem",
                whiteSpace: "nowrap",
                lineHeight: "2.25rem",
              }}>
                /blog/
              </span>
            )}
            <input
              type="text"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder={t("contentEditor.slugPlaceholder")}
              style={type === "post" ? { borderRadius: "0 4px 4px 0" } : undefined}
            />
          </div>
        </div>
      </div>

      <div className="editor-meta-row">
        <div className="form-group">
          <label>{t("contentEditor.fields.contentType")}</label>
          <select value={type} onChange={(e) => setType(e.target.value as ContentType)}>
            <option value="page">{t("contentEditor.contentTypeOptions.page")}</option>
            <option value="post">{t("contentEditor.contentTypeOptions.post")}</option>
          </select>
        </div>
        <div className="form-group">
          <label>{t("contentEditor.fields.status")}</label>
          <select value={status} onChange={(e) => setStatus(e.target.value as ContentStatus)}>
            <option value="draft">{t("contentEditor.statusOptions.draft")}</option>
            <option value="published">{t("contentEditor.statusOptions.published")}</option>
            <option value="archived">{t("contentEditor.statusOptions.archived")}</option>
          </select>
        </div>
        <div />
      </div>

      {!isNew && id && <CollectionPicker contentId={id} />}

      <div className="editor-seo-section">
        <div className="form-group">
          <label>{t("contentEditor.fields.seoTitle")}</label>
          <input
            type="text"
            value={seoTitle}
            onChange={(e) => setSeoTitle(e.target.value)}
            placeholder={title || t("contentEditor.seoTitlePlaceholderDefault")}
            maxLength={120}
          />
          <small className={`char-count${seoTitle.length > 60 ? " over" : ""}`}>
            {t("contentEditor.seoTitleHint", { count: seoTitle.length })}
          </small>
        </div>

        <div className="form-group">
          <label>{t("contentEditor.fields.metaDescription")}</label>
          <textarea
            rows={3}
            value={metaDescription}
            onChange={(e) => setMetaDescription(e.target.value)}
            placeholder={t("contentEditor.metaDescriptionPlaceholder")}
            maxLength={300}
          />
          <small className={`char-count${metaDescription.length > 160 ? " over" : ""}`}>
            {t("contentEditor.metaDescriptionHint", { count: metaDescription.length })}
          </small>
        </div>

        <div className="form-group">
          <label>{t("contentEditor.fields.featuredImage")}</label>
          {featuredImage ? (
            <div className="featured-image-preview">
              <img src={featuredImage} alt={t("contentEditor.featuredImageAlt")} />
              <div className="featured-image-actions">
                <button type="button" className="btn btn-sm" onClick={() => setShowMediaPicker(true)}>
                  {t("contentEditor.change")}
                </button>
                <button type="button" className="btn btn-sm" onClick={() => setShowImagePrompt(true)}>
                  {t("contentEditor.generateWithAi")}
                </button>
                <button type="button" className="btn btn-sm btn-danger" onClick={() => setFeaturedImage("")}>
                  {t("contentEditor.remove")}
                </button>
              </div>
            </div>
          ) : (
            <div className="featured-image-empty">
              <button type="button" className="btn" onClick={() => setShowMediaPicker(true)}>
                {t("contentEditor.browseMedia")}
              </button>
              <button type="button" className="btn" onClick={() => setShowImagePrompt(true)}>
                {t("contentEditor.generateWithAi")}
              </button>
            </div>
          )}
          {showImagePrompt && (
            <div className="image-prompt-input">
              <input
                type="text"
                value={imagePrompt}
                onChange={(e) => setImagePrompt(e.target.value)}
                placeholder={t("contentEditor.imagePromptPlaceholder")}
                disabled={generatingImage}
                onKeyDown={(e) => e.key === "Enter" && handleGenerateImage()}
              />
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={handleGenerateImage}
                disabled={generatingImage || !imagePrompt.trim()}
              >
                {generatingImage ? t("common.generating") : t("common.generate")}
              </button>
              <button type="button" className="btn btn-sm" onClick={() => { setShowImagePrompt(false); setImagePrompt(""); }}>
                {t("common.cancel")}
              </button>
            </div>
          )}
        </div>
      </div>

      {showMediaPicker && (
        <MediaPicker
          onSelect={(url) => { setFeaturedImage(url); setShowMediaPicker(false); }}
          onClose={() => setShowMediaPicker(false)}
        />
      )}

      <BlockEditor blocks={blocks} onChange={setBlocks} theme={theme} installedAddonSlugs={installedAddonSlugs} />

      {showHistory && (
        <div className="version-history-overlay" onClick={() => setShowHistory(false)}>
          <div className="version-history-panel" onClick={(e) => e.stopPropagation()}>
            <div className="version-history-header">
              <h3>{t("contentEditor.versionHistory.title")}</h3>
              <button type="button" className="btn btn-sm" onClick={() => setShowHistory(false)}>
                {t("common.close")}
              </button>
            </div>
            <div className="version-history-list">
              {loadingVersions ? (
                <p style={{ padding: "1rem", color: "var(--color-text-secondary)" }}>{t("contentEditor.versionHistory.loading")}</p>
              ) : versions.length === 0 ? (
                <p style={{ padding: "1rem", color: "var(--color-text-secondary)" }}>{t("contentEditor.versionHistory.empty")}</p>
              ) : (
                versions.map((v, i) => (
                  <div key={v.version} className={`version-history-item${i === 0 ? " current" : ""}`}>
                    <div className="version-history-info">
                      <strong>{t("contentEditor.versionHistory.versionLabel", { version: v.version })}</strong>
                      {i === 0 && <span className="version-badge">{t("contentEditor.versionHistory.current")}</span>}
                      <span className="version-date">
                        {new Date(v.createdAt).toLocaleString()}
                      </span>
                      {v.authorName && (
                        <span className="version-author">{t("contentEditor.versionHistory.byAuthor", { name: v.authorName })}</span>
                      )}
                      {typeof v.schemaData?.title === "string" && v.schemaData.title && (
                        <span className="version-title">{v.schemaData.title}</span>
                      )}
                    </div>
                    {i > 0 && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => handleRestore(v.version)}
                        disabled={restoringVersion !== null}
                      >
                        {restoringVersion === v.version ? t("common.restoring") : t("common.restore")}
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
