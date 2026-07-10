import { useState } from "react";
import type { HeroBlock } from "@cadmus/shared";
import { MediaPicker } from "../../MediaPicker";

const VARIANTS: HeroBlock["variant"][] = ["centered", "split", "video-bg", "image-bg"];

interface Props {
  data: HeroBlock["data"];
  variant: HeroBlock["variant"];
  onDataChange: (data: HeroBlock["data"]) => void;
  onVariantChange: (variant: HeroBlock["variant"]) => void;
}

export function HeroEditor({ data, variant, onDataChange, onVariantChange }: Props) {
  const [showPicker, setShowPicker] = useState(false);
  const update = (field: keyof HeroBlock["data"], value: string) => {
    onDataChange({ ...data, [field]: value });
  };

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
        <label>Headline</label>
        <input
          type="text"
          value={data.headline}
          onChange={(e) => update("headline", e.target.value)}
          placeholder="Main headline..."
        />
      </div>
      <div className="form-group">
        <label>Subheadline</label>
        <input
          type="text"
          value={data.subheadline ?? ""}
          onChange={(e) => update("subheadline", e.target.value)}
          placeholder="Supporting text..."
        />
      </div>
      <div className="block-fields-row">
        <div className="form-group">
          <label>CTA Text</label>
          <input
            type="text"
            value={data.ctaText ?? ""}
            onChange={(e) => update("ctaText", e.target.value)}
            placeholder="Get Started"
          />
        </div>
        <div className="form-group">
          <label>CTA URL</label>
          <input
            type="text"
            value={data.ctaUrl ?? ""}
            onChange={(e) => update("ctaUrl", e.target.value)}
            placeholder="/signup"
          />
        </div>
      </div>
      <div className="form-group">
        <label>Image URL</label>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <input
            type="text"
            value={data.imageUrl ?? ""}
            onChange={(e) => update("imageUrl", e.target.value)}
            placeholder="https://..."
            style={{ flex: 1 }}
          />
          <button type="button" className="btn" onClick={() => setShowPicker(true)}>
            Browse media
          </button>
        </div>
      </div>
      {showPicker && (
        <MediaPicker
          onSelect={(url) => {
            update("imageUrl", url);
            setShowPicker(false);
          }}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  );
}
