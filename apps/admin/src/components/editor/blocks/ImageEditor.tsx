import { useState } from "react";
import type { ImageBlock } from "@cadmus/shared";
import { MediaPicker } from "../../MediaPicker";
import { ai } from "../../../lib/api";

const VARIANTS: ImageBlock["variant"][] = ["full-width", "contained", "rounded"];

interface Props {
  data: ImageBlock["data"];
  variant: ImageBlock["variant"];
  onDataChange: (data: ImageBlock["data"]) => void;
  onVariantChange: (variant: ImageBlock["variant"]) => void;
}

export function ImageEditor({ data, variant, onDataChange, onVariantChange }: Props) {
  const [showPicker, setShowPicker] = useState(false);
  const [showAiPrompt, setShowAiPrompt] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [generating, setGenerating] = useState(false);

  const update = (field: keyof ImageBlock["data"], value: string) => {
    onDataChange({ ...data, [field]: value });
  };

  const handleGenerate = async () => {
    if (!aiPrompt.trim()) return;
    setGenerating(true);
    try {
      const res = await ai.generateImage(aiPrompt);
      update("url", res.url);
      setShowAiPrompt(false);
      setAiPrompt("");
    } catch {
      // silent — user will see no image appeared
    } finally {
      setGenerating(false);
    }
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
        <label>Image URL</label>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <input
            type="text"
            value={data.url}
            onChange={(e) => update("url", e.target.value)}
            placeholder="https://..."
            style={{ flex: 1 }}
          />
          <button type="button" className="btn" onClick={() => setShowPicker(true)}>
            Browse media
          </button>
          <button type="button" className="btn" onClick={() => setShowAiPrompt(!showAiPrompt)}>
            Generate with AI
          </button>
        </div>
        {showAiPrompt && (
          <div className="image-prompt-input" style={{ marginTop: "0.5rem" }}>
            <input
              type="text"
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              placeholder="Describe the image you want..."
              disabled={generating}
              onKeyDown={(e) => e.key === "Enter" && handleGenerate()}
              style={{ flex: 1 }}
            />
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={handleGenerate}
              disabled={generating || !aiPrompt.trim()}
            >
              {generating ? "Generating..." : "Generate"}
            </button>
          </div>
        )}
      </div>
      <div className="form-group">
        <label>Alt Text</label>
        <input
          type="text"
          value={data.alt}
          onChange={(e) => update("alt", e.target.value)}
          placeholder="Describe the image..."
        />
      </div>
      <div className="form-group">
        <label>Caption</label>
        <input
          type="text"
          value={data.caption ?? ""}
          onChange={(e) => update("caption", e.target.value)}
          placeholder="Optional caption..."
        />
      </div>
      {showPicker && (
        <MediaPicker
          onSelect={(url) => {
            update("url", url);
            setShowPicker(false);
          }}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  );
}
