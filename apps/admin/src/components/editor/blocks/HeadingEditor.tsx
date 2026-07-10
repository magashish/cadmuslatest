import type { HeadingBlock } from "@cadmus/shared";

const VARIANTS: HeadingBlock["variant"][] = ["default", "with-subtitle", "centered"];
const LEVELS: HeadingBlock["data"]["level"][] = [1, 2, 3, 4];

interface Props {
  data: HeadingBlock["data"];
  variant: HeadingBlock["variant"];
  onDataChange: (data: HeadingBlock["data"]) => void;
  onVariantChange: (variant: HeadingBlock["variant"]) => void;
}

export function HeadingEditor({ data, variant, onDataChange, onVariantChange }: Props) {
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
        <input
          type="text"
          value={data.text}
          onChange={(e) => onDataChange({ ...data, text: e.target.value })}
          placeholder="Heading text..."
        />
      </div>
      <div className="form-group">
        <label>Level</label>
        <div className="variant-picker-inline">
          {LEVELS.map((lvl) => (
            <button
              key={lvl}
              type="button"
              className={`variant-chip${data.level === lvl ? " active" : ""}`}
              onClick={() => onDataChange({ ...data, level: lvl })}
            >
              H{lvl}
            </button>
          ))}
        </div>
      </div>
      {variant === "with-subtitle" && (
        <div className="form-group">
          <label>Subtitle</label>
          <input
            type="text"
            value={data.subtitle ?? ""}
            onChange={(e) => onDataChange({ ...data, subtitle: e.target.value })}
            placeholder="Optional subtitle..."
          />
        </div>
      )}
    </div>
  );
}
