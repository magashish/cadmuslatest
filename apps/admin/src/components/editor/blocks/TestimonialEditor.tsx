import type { TestimonialBlock } from "@cadmus/shared";

const VARIANTS: TestimonialBlock["variant"][] = ["carousel", "grid", "single-feature"];

interface Props {
  data: TestimonialBlock["data"];
  variant: TestimonialBlock["variant"];
  onDataChange: (data: TestimonialBlock["data"]) => void;
  onVariantChange: (variant: TestimonialBlock["variant"]) => void;
}

export function TestimonialEditor({ data, variant, onDataChange, onVariantChange }: Props) {
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
      items: [...items, { quote: "", name: "" }],
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
              <span>Testimonial {index + 1}</span>
              <button
                type="button"
                className="btn btn-sm danger"
                onClick={() => removeItem(index)}
              >
                Remove
              </button>
            </div>
            <div className="form-group">
              <label>Quote</label>
              <textarea
                rows={3}
                value={item.quote}
                onChange={(e) => updateItem(index, "quote", e.target.value)}
                placeholder="What they said..."
              />
            </div>
            <div className="block-fields-row">
              <div className="form-group">
                <label>Name</label>
                <input
                  type="text"
                  value={item.name}
                  onChange={(e) => updateItem(index, "name", e.target.value)}
                  placeholder="John Doe"
                />
              </div>
              <div className="form-group">
                <label>Title</label>
                <input
                  type="text"
                  value={item.title ?? ""}
                  onChange={(e) => updateItem(index, "title", e.target.value)}
                  placeholder="CEO at Company"
                />
              </div>
            </div>
            <div className="form-group">
              <label>Image URL</label>
              <input
                type="text"
                value={item.imageUrl ?? ""}
                onChange={(e) => updateItem(index, "imageUrl", e.target.value)}
                placeholder="https://..."
              />
            </div>
          </div>
        ))}
      </div>

      <button type="button" className="btn btn-sm" onClick={addItem}>
        + Add Testimonial
      </button>
    </div>
  );
}
