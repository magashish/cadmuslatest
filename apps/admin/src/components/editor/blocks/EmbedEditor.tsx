import type { EmbedBlock } from "@cadmus/shared";

const VARIANTS: EmbedBlock["variant"][] = ["default"];

interface Props {
  data: EmbedBlock["data"];
  variant: EmbedBlock["variant"];
  onDataChange: (data: EmbedBlock["data"]) => void;
  onVariantChange: (variant: EmbedBlock["variant"]) => void;
}

export function EmbedEditor({ data, variant, onDataChange, onVariantChange }: Props) {
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
        <label>HTML</label>
        <textarea
          rows={8}
          value={data.html}
          onChange={(e) => onDataChange({ ...data, html: e.target.value })}
          placeholder="Paste embed HTML code here..."
          style={{ fontFamily: "monospace", fontSize: "0.85rem" }}
        />
      </div>
    </div>
  );
}
