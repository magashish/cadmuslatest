import type { ParagraphBlock } from "@cadmus/shared";

const VARIANTS: ParagraphBlock["variant"][] = ["default"];

interface Props {
  data: ParagraphBlock["data"];
  variant: ParagraphBlock["variant"];
  onDataChange: (data: ParagraphBlock["data"]) => void;
  onVariantChange: (variant: ParagraphBlock["variant"]) => void;
}

export function ParagraphEditor({ data, variant, onDataChange, onVariantChange }: Props) {
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
        <label>Text</label>
        <textarea
          rows={4}
          value={data.text}
          onChange={(e) => onDataChange({ ...data, text: e.target.value })}
          placeholder="Write your paragraph text here..."
        />
      </div>
    </div>
  );
}
