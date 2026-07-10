import { useState } from "react";
import type { VideoBlock } from "@cadmus/shared";
import { MediaPicker } from "../../MediaPicker";

const VARIANTS: VideoBlock["variant"][] = ["embed", "full-width", "contained"];

interface Props {
  data: VideoBlock["data"];
  variant: VideoBlock["variant"];
  onDataChange: (data: VideoBlock["data"]) => void;
  onVariantChange: (variant: VideoBlock["variant"]) => void;
}

export function VideoEditor({ data, variant, onDataChange, onVariantChange }: Props) {
  const [showPicker, setShowPicker] = useState(false);
  const source = data.source ?? "url";

  return (
    <div>
      <div className="form-group">
        <label>Variant</label>
        <div className="variant-picker-inline">
          {VARIANTS.map((v) => (
            <button
              key={v}
              type="button"
              className={`variant-chip${variant === v ? " active" : ""}`}
              onClick={() => onVariantChange(v)}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      <div className="form-group">
        <label>Source</label>
        <div className="variant-picker-inline">
          <button
            type="button"
            className={`variant-chip${source === "url" ? " active" : ""}`}
            onClick={() => onDataChange({ ...data, source: "url" })}
          >
            URL
          </button>
          <button
            type="button"
            className={`variant-chip${source === "library" ? " active" : ""}`}
            onClick={() => onDataChange({ ...data, source: "library" })}
          >
            Media Library
          </button>
        </div>
      </div>

      {source === "url" ? (
        <div className="form-group">
          <label>Video URL</label>
          <input
            type="text"
            value={data.url}
            onChange={(e) => onDataChange({ ...data, url: e.target.value })}
            placeholder="https://youtube.com/watch?v=..."
          />
        </div>
      ) : (
        <div className="form-group">
          <label>Video</label>
          {data.mediaUrl ? (
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <span style={{ fontSize: "0.85rem", color: "#374151", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {data.mediaUrl.split("/").pop()}
              </span>
              <button type="button" className="btn btn-sm" onClick={() => setShowPicker(true)}>
                Change
              </button>
            </div>
          ) : (
            <button type="button" className="btn btn-sm" onClick={() => setShowPicker(true)}>
              Choose from Media Library
            </button>
          )}
        </div>
      )}

      <div className="form-group">
        <label>Title</label>
        <input
          type="text"
          value={data.title ?? ""}
          onChange={(e) => onDataChange({ ...data, title: e.target.value })}
          placeholder="Video title"
        />
      </div>

      <div className="form-group">
        <label>
          <input
            type="checkbox"
            checked={data.autoplay ?? false}
            onChange={(e) => onDataChange({ ...data, autoplay: e.target.checked })}
          />{" "}
          Autoplay
        </label>
      </div>

      {showPicker && (
        <MediaPicker
          mimeFilter="video"
          onSelect={(url) => {
            onDataChange({ ...data, mediaUrl: url });
            setShowPicker(false);
          }}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  );
}
