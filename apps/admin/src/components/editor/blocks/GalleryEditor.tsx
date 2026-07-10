import type { GalleryBlock } from "@cadmus/shared";

const VARIANTS: GalleryBlock["variant"][] = ["grid", "masonry", "carousel"];

interface Props {
  data: GalleryBlock["data"];
  variant: GalleryBlock["variant"];
  onDataChange: (data: GalleryBlock["data"]) => void;
  onVariantChange: (variant: GalleryBlock["variant"]) => void;
}

export function GalleryEditor({ data, variant, onDataChange, onVariantChange }: Props) {
  const items = data.items;

  const updateItem = (index: number, field: string, value: string) => {
    const updated = items.map((item, i) =>
      i === index ? { ...item, [field]: value } : item
    );
    onDataChange({ ...data, items: updated });
  };

  const addItem = () => {
    onDataChange({
      ...data,
      items: [...items, { url: "", alt: "" }],
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

      <div className="form-group">
        <label>Columns</label>
        <input
          type="number"
          min={1}
          max={6}
          value={data.columns ?? 3}
          onChange={(e) => onDataChange({ ...data, columns: parseInt(e.target.value) || 3 })}
        />
      </div>

      <div className="list-editor-items">
        {items.map((item, index) => (
          <div key={index} className="list-editor-item">
            <div className="list-item-header">
              <span>Image {index + 1}</span>
              <button
                type="button"
                className="btn btn-sm danger"
                onClick={() => removeItem(index)}
              >
                Remove
              </button>
            </div>
            <div className="form-group">
              <label>URL</label>
              <input
                type="text"
                value={item.url}
                onChange={(e) => updateItem(index, "url", e.target.value)}
                placeholder="https://..."
              />
            </div>
            <div className="form-group">
              <label>Alt Text</label>
              <input
                type="text"
                value={item.alt}
                onChange={(e) => updateItem(index, "alt", e.target.value)}
                placeholder="Describe the image"
              />
            </div>
            <div className="form-group">
              <label>Caption</label>
              <input
                type="text"
                value={item.caption ?? ""}
                onChange={(e) => updateItem(index, "caption", e.target.value)}
                placeholder="Optional caption"
              />
            </div>
          </div>
        ))}
      </div>

      <button type="button" className="btn btn-sm" onClick={addItem}>
        + Add Image
      </button>
    </div>
  );
}
