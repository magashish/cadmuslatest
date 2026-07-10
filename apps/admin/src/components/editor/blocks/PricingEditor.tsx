import { useState } from "react";
import type { PricingBlock } from "@cadmus/shared";

const VARIANTS: PricingBlock["variant"][] = ["cards", "table", "simple"];

interface Props {
  data: PricingBlock["data"];
  variant: PricingBlock["variant"];
  onDataChange: (data: PricingBlock["data"]) => void;
  onVariantChange: (variant: PricingBlock["variant"]) => void;
}

export function PricingEditor({ data, variant, onDataChange, onVariantChange }: Props) {
  const items = data.items;
  // Raw textarea values indexed by plan — lets user type trailing commas/spaces
  // without them being stripped mid-keystroke. Normalised on blur.
  const [featuresRaw, setFeaturesRaw] = useState<Record<number, string>>({});

  const updateItem = (index: number, field: string, value: unknown) => {
    const updated = items.map((item, i) =>
      i === index ? { ...item, [field]: value } : item
    );
    onDataChange({ ...data, items: updated });
  };

  const addItem = () => {
    onDataChange({
      ...data,
      items: [...items, { name: "", price: "", features: [] }],
    });
  };

  const removeItem = (index: number) => {
    onDataChange({
      ...data,
      items: items.filter((_, i) => i !== index),
    });
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

      <div className="list-editor-items">
        {items.map((item, index) => (
          <div key={index} className="list-editor-item">
            <div className="list-item-header">
              <span>Plan {index + 1}</span>
              <button
                type="button"
                className="btn btn-sm danger"
                onClick={() => removeItem(index)}
              >
                Remove
              </button>
            </div>
            <div className="form-group">
              <label>Name</label>
              <input
                type="text"
                value={item.name}
                onChange={(e) => updateItem(index, "name", e.target.value)}
                placeholder="Basic"
              />
            </div>
            <div className="form-group">
              <label>Price</label>
              <input
                type="text"
                value={item.price}
                onChange={(e) => updateItem(index, "price", e.target.value)}
                placeholder="$9.99"
              />
            </div>
            <div className="form-group">
              <label>Period</label>
              <input
                type="text"
                value={item.period ?? ""}
                onChange={(e) => updateItem(index, "period", e.target.value)}
                placeholder="/month"
              />
            </div>
            <div className="form-group">
              <label>Description</label>
              <input
                type="text"
                value={item.description ?? ""}
                onChange={(e) => updateItem(index, "description", e.target.value)}
                placeholder="Perfect for small teams"
              />
            </div>
            <div className="form-group">
              <label>Features (comma-separated)</label>
              <textarea
                rows={2}
                value={featuresRaw[index] ?? item.features.join(", ")}
                onChange={(e) => setFeaturesRaw((prev) => ({ ...prev, [index]: e.target.value }))}
                onBlur={(e) => {
                  const parsed = e.target.value.split(",").map((s) => s.trim()).filter(Boolean);
                  updateItem(index, "features", parsed);
                  setFeaturesRaw((prev) => { const next = { ...prev }; delete next[index]; return next; });
                }}
                placeholder="Feature 1, Feature 2, Feature 3"
              />
            </div>
            <div className="form-group">
              <label>CTA Text</label>
              <input
                type="text"
                value={item.ctaText ?? ""}
                onChange={(e) => updateItem(index, "ctaText", e.target.value)}
                placeholder="Get Started"
              />
            </div>
            <div className="form-group">
              <label>CTA URL</label>
              <input
                type="text"
                value={item.ctaUrl ?? ""}
                onChange={(e) => updateItem(index, "ctaUrl", e.target.value)}
                placeholder="https://..."
              />
            </div>
            <div className="form-group">
              <label>
                <input
                  type="checkbox"
                  checked={item.highlighted ?? false}
                  onChange={(e) => updateItem(index, "highlighted", e.target.checked)}
                />{" "}
                Highlighted
              </label>
            </div>
          </div>
        ))}
      </div>

      <button type="button" className="btn btn-sm" onClick={addItem}>
        + Add Plan
      </button>
    </div>
  );
}
