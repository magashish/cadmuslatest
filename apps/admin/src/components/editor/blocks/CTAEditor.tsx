import type { CTABlock } from "@cadmus/shared";

const VARIANTS: CTABlock["variant"][] = ["banner", "inline", "card"];

interface Props {
  data: CTABlock["data"];
  variant: CTABlock["variant"];
  onDataChange: (data: CTABlock["data"]) => void;
  onVariantChange: (variant: CTABlock["variant"]) => void;
}

export function CTAEditor({ data, variant, onDataChange, onVariantChange }: Props) {
  const update = (field: keyof CTABlock["data"], value: string) => {
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
          placeholder="Call to action headline..."
        />
      </div>
      <div className="form-group">
        <label>Description</label>
        <textarea
          rows={3}
          value={data.description ?? ""}
          onChange={(e) => update("description", e.target.value)}
          placeholder="Supporting description..."
        />
      </div>
      <div className="block-fields-row">
        <div className="form-group">
          <label>Button Text</label>
          <input
            type="text"
            value={data.buttonText}
            onChange={(e) => update("buttonText", e.target.value)}
            placeholder="Sign Up"
          />
        </div>
        <div className="form-group">
          <label>Button URL</label>
          <input
            type="text"
            value={data.buttonUrl}
            onChange={(e) => update("buttonUrl", e.target.value)}
            placeholder="/signup"
          />
        </div>
      </div>
    </div>
  );
}
