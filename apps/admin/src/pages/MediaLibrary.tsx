import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../context/AuthContext";
import { media, ai } from "../lib/api";

interface MediaItem {
  id: string;
  filename: string;
  storageUrl: string;
  mimeType: string;
  aiAltText?: string;
  moderationStatus?: string;
  moderationReason?: string | null;
  thumbnailUrl?: string;
}

function FileTypeIcon({ mimeType }: { mimeType: string }) {
  const style: React.CSSProperties = { width: 14, height: 14, flexShrink: 0, color: "var(--color-text-muted)", verticalAlign: "middle", marginRight: "0.3rem" };
  if (mimeType?.startsWith("video/")) {
    return (
      <svg style={style} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
      </svg>
    );
  }
  if (mimeType === "application/pdf") {
    return (
      <svg style={style} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
      </svg>
    );
  }
  // image
  return (
    <svg style={style} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
    </svg>
  );
}

const PAGE_SIZE = 24;

export function MediaLibrary() {
  const { t } = useTranslation();
  const { user, siteStatus } = useAuth();
  const [items, setItems] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadLabel, setUploadLabel] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trialLimitHit, setTrialLimitHit] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [showGenerate, setShowGenerate] = useState(false);
  const [generatePrompt, setGeneratePrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editAlt, setEditAlt] = useState("");
  const [editFilename, setEditFilename] = useState("");
  const [savingMeta, setSavingMeta] = useState(false);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [typeFilter, setTypeFilter] = useState<"" | "image" | "video" | "application/pdf">("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadMedia = useCallback(async () => {
    if (!user) return;
    try {
      setLoading(true);
      const res = await media.list({
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        ...(typeFilter ? { mime: typeFilter.replace(/\/$/, "") } : {}),
      });
      setItems(res.items as MediaItem[]);
      setTotal(res.total);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [user, page, typeFilter]);

  useEffect(() => {
    loadMedia();
  }, [loadMedia]);

  useEffect(() => {
    const handler = () => {
      setPage(0);
      loadMedia();
    };
    window.addEventListener("cadmus:content-updated", handler);
    return () => window.removeEventListener("cadmus:content-updated", handler);
  }, [loadMedia]);

  // Poll pending items every 3s until they resolve (scanner sets thumbnailUrl + status)
  useEffect(() => {
    const pendingIds = items.filter((i) => i.moderationStatus === "pending").map((i) => i.id);
    if (pendingIds.length === 0) return;
    const timer = setInterval(async () => {
      const updates = await Promise.all(pendingIds.map((id) => media.get(id).catch(() => null)));
      setItems((prev) => prev.map((item) => {
        const updated = updates.find((u) => u && (u as MediaItem).id === item.id) as MediaItem | null;
        return updated ?? item;
      }));
    }, 3000);
    return () => clearInterval(timer);
  }, [items]);

  const ALLOWED_MIME_TYPES = ["image/", "video/", "application/pdf"];
  const MAX_BYTES = siteStatus === "trialing" ? 100 * 1024 * 1024 : 500 * 1024 * 1024;
  const MAX_LABEL = siteStatus === "trialing" ? "100 MB" : "500 MB";

  const handleUpload = async (files: FileList | null) => {
    if (!files?.length || !user) return;
    setUploading(true);
    setError(null);
    setTrialLimitHit(false);
    try {
      const fileArray = Array.from(files);
      for (let index = 0; index < fileArray.length; index++) {
        const file = fileArray[index];
        if (!ALLOWED_MIME_TYPES.some((mt) => file.type.startsWith(mt))) {
          setError(t("mediaLibrary.invalidFileType", { name: file.name }));
          continue;
        }
        if (file.size > MAX_BYTES) {
          if (siteStatus === "trialing") {
            setTrialLimitHit(true);
          } else {
            setError(t("mediaLibrary.fileTooLarge", { name: file.name, limit: MAX_LABEL }));
          }
          continue;
        }
        setUploadLabel(
          fileArray.length > 1
            ? t("mediaLibrary.uploadingFileWithCount", { name: file.name, index: index + 1, total: fileArray.length })
            : t("mediaLibrary.uploadingFile", { name: file.name })
        );
        const result = (file.type.startsWith("video/") || file.type === "application/pdf")
          ? await media.uploadVideo(file, (pct) => setUploadProgress(pct))
          : await media.upload(file, user.id, (pct) => setUploadProgress(pct));
        if ((result as { error?: string }).error) {
          setError((result as { error: string }).error);
          continue;
        }
        setItems((prev) => [result as MediaItem, ...prev]);
      }
    } catch (err) {
      const e = err as Error & { code?: string };
      if (e.code === "trial_limit_exceeded") {
        setTrialLimitHit(true);
      } else {
        setError(e.message || t("common.uploadFailed"));
      }
    } finally {
      setUploading(false);
      setUploadProgress(null);
      setUploadLabel(null);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await media.delete(id, user?.id);
      setItems((prev) => prev.filter((item) => item.id !== id));
    } catch {
      // silent
    }
  };

  const copyUrl = (id: string, url: string) => {
    navigator.clipboard.writeText(url);
    setCopiedId(id);
    setTimeout(() => setCopiedId((prev) => (prev === id ? null : prev)), 2000);
  };

  const handleGenerate = async () => {
    if (!generatePrompt.trim() || generating) return;
    setGenerating(true);
    setError(null);
    try {
      const result = await ai.generateImage(generatePrompt);
      setItems((prev) => [{ id: result.mediaId, filename: result.filename || "ai-generated.png", storageUrl: result.url, mimeType: "image/png", aiAltText: generatePrompt } as MediaItem, ...prev]);
      setGeneratePrompt("");
      setShowGenerate(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("mediaLibrary.generateFailed"));
    } finally {
      setGenerating(false);
    }
  };

  const stripExtension = (filename: string) => filename.replace(/\.[^.]+$/, "");
  const getFileExtension = (filename: string) => {
    const m = filename.match(/(\.[^.]+)$/);
    return m ? m[1] : "";
  };

  const startEditing = (item: MediaItem) => {
    setEditingId(item.id);
    setEditAlt(item.aiAltText || "");
    setEditFilename(stripExtension(item.filename));
  };

  const cancelEditing = () => {
    setEditingId(null);
    setEditAlt("");
    setEditFilename("");
  };

  const saveMeta = async (id: string) => {
    setSavingMeta(true);
    try {
      const ext = getFileExtension(items.find((i) => i.id === id)?.filename ?? "");
      const savedFilename = editFilename + ext;
      await media.update(id, { aiAltText: editAlt, filename: savedFilename, updatedBy: user?.id });
      setItems((prev) => prev.map((item) =>
        item.id === id ? { ...item, aiAltText: editAlt, filename: savedFilename } : item
      ));
      setEditingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("mediaLibrary.saveMetaFailed"));
    } finally {
      setSavingMeta(false);
    }
  };

  const isImage = (mime: string) => mime?.startsWith("image/");

  const getExtension = (filename: string) => {
    const parts = filename.split(".");
    return parts.length > 1 ? parts.pop()!.toUpperCase() : "FILE";
  };

  return (
    <div className="page">
      <div className="page-header">
        <h2>{t("mediaLibrary.title")}</h2>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button
            className="btn btn-primary"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? (uploadProgress !== null ? `${uploadProgress}%` : t("common.uploading")) : t("common.upload")}
          </button>
          <button
            className="btn"
            onClick={() => setShowGenerate(!showGenerate)}
            disabled={generating}
          >
            {generating ? t("common.generating") : t("mediaLibrary.generateImage")}
          </button>
        </div>
      </div>

      {showGenerate && (
        <div className="image-prompt-input" style={{ marginBottom: "1rem" }}>
          <input
            type="text"
            value={generatePrompt}
            onChange={(e) => setGeneratePrompt(e.target.value)}
            placeholder={t("mediaLibrary.generatePromptPlaceholder")}
            disabled={generating}
            onKeyDown={(e) => e.key === "Enter" && handleGenerate()}
            style={{ flex: 1 }}
          />
          <button
            className="btn btn-primary btn-sm"
            onClick={handleGenerate}
            disabled={generating || !generatePrompt.trim()}
          >
            {generating ? t("common.generating") : t("common.generate")}
          </button>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,video/*,application/pdf"
        style={{ display: "none" }}
        onChange={(e) => handleUpload(e.target.files)}
      />

      {uploadProgress !== null && (
        <div style={{ marginBottom: "0.75rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.8rem", marginBottom: "0.25rem" }}>
            <span>{uploadLabel ?? t("common.uploading")}</span>
            <span>{uploadProgress}%</span>
          </div>
          <div style={{ background: "#e5e7eb", borderRadius: "4px", height: "6px", overflow: "hidden" }}>
            <div style={{ background: "#2563eb", height: "100%", width: `${uploadProgress}%`, transition: "width 0.2s" }} />
          </div>
        </div>
      )}
      {error && <div className="editor-status error">{error}</div>}
      {trialLimitHit && (
        <div className="auth-error" style={{ marginBottom: "1rem" }}>
          {t("mediaLibrary.trialLimitMessage")}{" "}
          <a href="/settings?tab=billing" style={{ color: "inherit", fontWeight: 600 }}>
            {t("common.addPaymentMethod")}
          </a>{" "}
          {t("mediaLibrary.trialLimitSuffix")}
        </div>
      )}

      {!loading && (
        <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.75rem" }}>
          {(["", "image", "video", "application/pdf"] as const).map((f) => (
            <button
              key={f}
              className={`btn btn-sm${typeFilter === f ? " btn-primary" : ""}`}
              onClick={() => { setTypeFilter(f); setPage(0); }}
            >
              {f === "" ? t("mediaLibrary.filters.all") : f === "image" ? t("mediaLibrary.filters.images") : f === "video" ? t("mediaLibrary.filters.videos") : t("mediaLibrary.filters.pdfs")}
            </button>
          ))}
        </div>
      )}

      <div
        className={`upload-zone${dragOver ? " drag-over" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          handleUpload(e.dataTransfer.files);
        }}
      >
        {t("mediaLibrary.dropZone")}
      </div>

      {loading ? (
        <p>{t("mediaLibrary.loadingMedia")}</p>
      ) : items.length === 0 ? (
        <p>{t("mediaLibrary.empty")}</p>
      ) : (
        <div className="media-grid">
          {items.map((item) => (
            <div key={item.id} className="media-card" style={item.moderationStatus === "blocked" ? { borderLeft: "3px solid var(--color-danger, #c33)" } : undefined}>
              {item.moderationStatus === "blocked" ? (
                <>
                  <div style={{ padding: "0.5rem", background: "var(--color-danger-subtle, #fee2e2)", borderRadius: "4px", marginBottom: "0.35rem" }}>
                    <div style={{ fontSize: "0.75rem", fontWeight: 700, color: "var(--color-danger, #c33)" }}>
                      {item.mimeType?.startsWith("video/") ? t("mediaLibrary.blockedVideo") : t("mediaLibrary.blockedFile")}
                    </div>
                    {item.moderationReason && (
                      <div style={{ fontSize: "0.72rem", color: "var(--color-text-muted)", marginTop: "0.2rem" }}>{item.moderationReason}</div>
                    )}
                  </div>
                  <div className="media-card-name" style={{ display: "flex", alignItems: "center" }}>
                    <FileTypeIcon mimeType={item.mimeType} />
                    {item.filename}
                  </div>
                  <div className="media-card-actions">
                    <button className="btn btn-sm" onClick={() => handleDelete(item.id)}>{t("common.delete")}</button>
                  </div>
                </>
              ) : isImage(item.mimeType) ? (
                <img src={item.storageUrl} alt={item.aiAltText || item.filename} />
              ) : item.mimeType?.startsWith("video/") ? (
                <div className="media-card-video-thumb">
                  {item.thumbnailUrl && (
                    <img src={item.thumbnailUrl} alt={item.filename} />
                  )}
                  {item.moderationStatus === "pending" && (
                    <div className="media-card-video-badge media-card-video-badge--pending">{t("mediaLibrary.processing")}</div>
                  )}
                  {item.moderationStatus === "review" && (
                    <div className="media-card-video-badge media-card-video-badge--review">{t("mediaLibrary.underReview")}</div>
                  )}
                  {item.moderationStatus === "blocked" && (
                    <div className="media-card-video-badge media-card-video-badge--blocked">{t("mediaLibrary.blocked")}</div>
                  )}
                  {!item.thumbnailUrl && item.moderationStatus === "pending" && (
                    <div className="media-card-ext" style={{ position: "absolute", inset: 0 }}>
                      <span style={{ fontSize: "1.5rem" }}>⏳</span>
                    </div>
                  )}
                  {!item.thumbnailUrl && item.moderationStatus !== "pending" && item.moderationStatus !== "review" && item.moderationStatus !== "blocked" && (
                    <div className="media-card-ext" style={{ position: "absolute", inset: 0 }}>
                      {getExtension(item.filename)}
                    </div>
                  )}
                </div>
              ) : item.thumbnailUrl ? (
                <img src={item.thumbnailUrl} alt={item.filename} style={{ width: "100%", height: "150px", objectFit: "cover", display: "block" }} />
              ) : (
                <div className="media-card-ext">{getExtension(item.filename)}</div>
              )}

              {item.moderationStatus !== "blocked" && (editingId === item.id ? (
                <div className="media-card-edit">
                  <div className="form-group" style={{ marginBottom: "0.5rem" }}>
                    <label style={{ fontSize: "0.75rem", fontWeight: 600 }}>{t("mediaLibrary.displayName")}</label>
                    <input
                      type="text"
                      value={editFilename}
                      onChange={(e) => setEditFilename(e.target.value)}
                      style={{ fontSize: "0.8rem" }}
                    />
                  </div>
                  <div className="form-group" style={{ marginBottom: "0.5rem" }}>
                    <label style={{ fontSize: "0.75rem", fontWeight: 600 }}>{t("mediaLibrary.altTitle")}</label>
                    <textarea
                      rows={2}
                      value={editAlt}
                      onChange={(e) => setEditAlt(e.target.value)}
                      placeholder={t("mediaLibrary.altPlaceholder")}
                      style={{ fontSize: "0.8rem" }}
                    />
                  </div>
                  <div style={{ display: "flex", gap: "0.25rem" }}>
                    <button className="btn btn-primary btn-sm" onClick={() => saveMeta(item.id)} disabled={savingMeta}>
                      {savingMeta ? t("common.saving") : t("common.save")}
                    </button>
                    <button className="btn btn-sm" onClick={cancelEditing}>{t("common.cancel")}</button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="media-card-name" style={{ display: "flex", alignItems: "center" }}>
                    <FileTypeIcon mimeType={item.mimeType} />
                    {item.filename}
                  </div>
                  {item.aiAltText && (
                    <div className="media-card-alt" title={item.aiAltText}>
                      {item.aiAltText}
                    </div>
                  )}
                  <div className="media-card-actions">
                    <button className="btn btn-sm" onClick={() => startEditing(item)}>{t("common.edit")}</button>
                    {(!item.mimeType?.startsWith("video/") || item.moderationStatus === "approved") && (
                      <>
                        <button className="btn btn-sm" onClick={() => window.open(item.storageUrl, "_blank")}>{t("mediaLibrary.view")}</button>
                        <button className="btn btn-sm" onClick={() => copyUrl(item.id, item.storageUrl)}>{copiedId === item.id ? t("mediaLibrary.copied") : t("mediaLibrary.copyUrl")}</button>
                      </>
                    )}
                    <button className="btn btn-sm" onClick={() => handleDelete(item.id)}>{t("common.delete")}</button>
                  </div>
                </>
              ))}
            </div>
          ))}
        </div>
      )}

      {total > PAGE_SIZE && (
        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "center", alignItems: "center", marginTop: "1.5rem" }}>
          <button className="btn btn-sm" onClick={() => setPage((p) => p - 1)} disabled={page === 0}>{t("mediaLibrary.previous")}</button>
          <span style={{ fontSize: "0.875rem", color: "var(--color-text-muted)" }}>
            {t("mediaLibrary.pageOf", { page: page + 1, total: Math.ceil(total / PAGE_SIZE) })}
          </span>
          <button className="btn btn-sm" onClick={() => setPage((p) => p + 1)} disabled={(page + 1) * PAGE_SIZE >= total}>{t("mediaLibrary.next")}</button>
        </div>
      )}
    </div>
  );
}
