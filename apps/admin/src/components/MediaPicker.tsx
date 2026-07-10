import { useState, useEffect, useRef, useCallback } from "react";
import { useAuth } from "../context/AuthContext";
import { media } from "../lib/api";

interface MediaItem {
  id: string;
  filename: string;
  storageUrl: string;
  mimeType: string;
}

interface Props {
  onSelect: (url: string) => void;
  onClose: () => void;
  mimeFilter?: string;
}

export function MediaPicker({ onSelect, onClose, mimeFilter }: Props) {
  const { user } = useAuth();
  const [items, setItems] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [trialLimitHit, setTrialLimitHit] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadMedia = useCallback(async () => {
    if (!user) return;
    try {
      const res = await media.list({ mime: mimeFilter ?? "image", excludeBlocked: true });
      setItems(res.items as MediaItem[]);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    loadMedia();
  }, [loadMedia]);

  const handleUpload = async (files: FileList | null) => {
    if (!files?.length || !user) return;
    setUploading(true);
    setUploadError(null);
    setTrialLimitHit(false);
    try {
      for (const file of Array.from(files)) {
        const result = await media.upload(file, user?.id);
        setItems((prev) => [result as MediaItem, ...prev]);
      }
    } catch (err) {
      const e = err as Error & { code?: string };
      if (e.code === "trial_limit_exceeded") {
        setTrialLimitHit(true);
      } else {
        setUploadError(e.message || "Upload failed");
      }
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="block-picker-overlay" onClick={onClose}>
      <div className="media-picker" onClick={(e) => e.stopPropagation()}>
        <div className="page-header">
          <h3>Select Media</h3>
          <div>
            <button
              className="btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
            >
              {uploading ? "Uploading..." : "Upload"}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept={mimeFilter ? `${mimeFilter}/*` : "image/*"}
              multiple
              style={{ display: "none" }}
              onChange={(e) => handleUpload(e.target.files)}
            />
          </div>
        </div>
        {uploadError && (
          <p style={{ color: "#b91c1c", fontSize: "0.875rem", margin: "0.5rem 0" }}>{uploadError}</p>
        )}
        {trialLimitHit && (
          <div className="auth-error" style={{ margin: "0.5rem 0" }}>
            File exceeds the 100 MB trial limit.{" "}
            <a href="/settings?tab=billing" style={{ color: "inherit", fontWeight: 600 }}>
              Add a payment method
            </a>{" "}
            to upload up to 500 MB.
          </div>
        )}
        {loading ? (
          <p>Loading...</p>
        ) : items.length === 0 ? (
          <p>No images yet. Upload one above.</p>
        ) : (
          <div className="media-grid">
            {items.map((item) => (
              <div
                key={item.id}
                className="media-card media-card-selectable"
                onClick={() => onSelect(item.storageUrl)}
              >
                {item.mimeType?.startsWith("video/") ? (
                  <div className="media-card-ext">{item.filename.split(".").pop()?.toUpperCase() ?? "VIDEO"}</div>
                ) : (
                  <img src={item.storageUrl} alt={item.filename} />
                )}
                <div className="media-card-name">{item.filename}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
