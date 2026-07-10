import type { SectionBlock } from "@cadmus/shared";

const VARIANTS: SectionBlock["variant"][] = ["default"];

interface Props {
  data: SectionBlock["data"];
  variant: SectionBlock["variant"];
  onDataChange: (data: SectionBlock["data"]) => void;
  onVariantChange: (variant: SectionBlock["variant"]) => void;
}

export function SectionEditor({ data, variant, onDataChange, onVariantChange }: Props) {
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
        <label>Heading</label>
        <input
          type="text"
          value={data.heading ?? ""}
          onChange={(e) => onDataChange({ ...data, heading: e.target.value })}
          placeholder="Section heading"
        />
      </div>
      <div className="form-group">
        <label>Body</label>
        <textarea
          rows={5}
          value={data.body ?? ""}
          onChange={(e) => onDataChange({ ...data, body: e.target.value })}
          placeholder="Section body content..."
        />
      </div>
    </div>
  );
}
