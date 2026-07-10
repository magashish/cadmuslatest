import type { FAQBlock } from "@cadmus/shared";

const VARIANTS: FAQBlock["variant"][] = ["accordion", "two-col", "simple"];

interface Props {
  data: FAQBlock["data"];
  variant: FAQBlock["variant"];
  onDataChange: (data: FAQBlock["data"]) => void;
  onVariantChange: (variant: FAQBlock["variant"]) => void;
}

export function FAQEditor({ data, variant, onDataChange, onVariantChange }: Props) {
  const items = data.items;

  const updateItem = (index: number, field: "question" | "answer", value: string) => {
    const updated = items.map((item, i) =>
      i === index ? { ...item, [field]: value } : item
    );
    onDataChange({ ...data, items: updated });
  };

  const addItem = () => {
    onDataChange({
      ...data,
      items: [...items, { question: "", answer: "" }],
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
              <span>Question {index + 1}</span>
              <button
                type="button"
                className="btn btn-sm danger"
                onClick={() => removeItem(index)}
              >
                Remove
              </button>
            </div>
            <div className="form-group">
              <label>Question</label>
              <input
                type="text"
                value={item.question}
                onChange={(e) => updateItem(index, "question", e.target.value)}
                placeholder="What is...?"
              />
            </div>
            <div className="form-group">
              <label>Answer</label>
              <textarea
                rows={3}
                value={item.answer}
                onChange={(e) => updateItem(index, "answer", e.target.value)}
                placeholder="The answer is..."
              />
            </div>
          </div>
        ))}
      </div>

      <button type="button" className="btn btn-sm" onClick={addItem}>
        + Add Question
      </button>
    </div>
  );
}
