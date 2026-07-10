import type { FormBlock } from "@cadmus/shared";

const VARIANTS: FormBlock["variant"][] = ["contact", "newsletter", "custom"];
const FIELD_TYPES: FormBlock["data"]["fields"][number]["type"][] = [
  "text", "email", "textarea", "phone", "select", "checkbox",
];

interface Props {
  data: FormBlock["data"];
  variant: FormBlock["variant"];
  onDataChange: (data: FormBlock["data"]) => void;
  onVariantChange: (variant: FormBlock["variant"]) => void;
  installedAddonSlugs?: string[];
}

export function FormEditor({ data, variant, onDataChange, onVariantChange, installedAddonSlugs }: Props) {
  const fields = data.fields;

  // "file" requires the form-file-uploads add-on. Keep the option on fields
  // that already use it so uninstalling the add-on doesn't corrupt the editor.
  const fileUploadsEnabled = installedAddonSlugs?.includes("form-file-uploads") ?? false;
  const fieldTypesFor = (current: string): FormBlock["data"]["fields"][number]["type"][] =>
    fileUploadsEnabled || current === "file" ? [...FIELD_TYPES, "file"] : FIELD_TYPES;

  const updateField = (index: number, field: string, value: unknown) => {
    const updated = fields.map((f, i) =>
      i === index ? { ...f, [field]: value } : f
    );
    onDataChange({ ...data, fields: updated });
  };

  const addField = () => {
    onDataChange({
      ...data,
      fields: [...fields, { name: "", type: "text" as const, label: "" }],
    });
  };

  const removeField = (index: number) => {
    onDataChange({
      ...data,
      fields: fields.filter((_, i) => i !== index),
    });
  };

  return (
    <div>
      <div className="form-group">
        <label>Form Name</label>
        <input
          type="text"
          value={data.name ?? ""}
          onChange={(e) => onDataChange({ ...data, name: e.target.value })}
          placeholder="e.g. Contact Form, Newsletter Signup"
        />
        <small style={{ color: "#888" }}>Shown on the Forms page to identify submissions</small>
      </div>

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
        <label>Submit Button Text</label>
        <input
          type="text"
          value={data.submitText}
          onChange={(e) => onDataChange({ ...data, submitText: e.target.value })}
          placeholder="Submit"
        />
      </div>

      <h4 style={{ marginTop: "1.25rem", marginBottom: "0.5rem" }}>Post-Submit Behavior</h4>

      <div className="form-group">
        <label>Success Message</label>
        <input
          type="text"
          value={data.successMessage ?? ""}
          onChange={(e) => onDataChange({ ...data, successMessage: e.target.value })}
          placeholder="Thanks for your submission!"
        />
      </div>
      <div className="form-group">
        <label>Redirect URL</label>
        <input
          type="text"
          value={data.redirectUrl ?? ""}
          onChange={(e) => onDataChange({ ...data, redirectUrl: e.target.value })}
          placeholder="https://example.com/thank-you"
        />
        <small style={{ color: "#888" }}>If set, redirects instead of showing the success message</small>
      </div>

      <h4 style={{ marginTop: "1.25rem", marginBottom: "0.5rem" }}>Notifications</h4>

      <div className="form-group">
        <label>Notification Email</label>
        <input
          type="email"
          value={data.notificationEmail ?? ""}
          onChange={(e) => onDataChange({ ...data, notificationEmail: e.target.value })}
          placeholder="you@example.com"
        />
        <small style={{ color: "#888" }}>Where submission alerts are sent</small>
      </div>
      <div className="form-group">
        <label>
          <input
            type="checkbox"
            checked={data.confirmationEnabled ?? false}
            onChange={(e) => onDataChange({ ...data, confirmationEnabled: e.target.checked })}
          />{" "}
          Send confirmation email to submitter
        </label>
      </div>
      {data.confirmationEnabled && (
        <div className="form-group">
          <label>Confirmation Message</label>
          <textarea
            value={data.confirmationMessage ?? ""}
            onChange={(e) => onDataChange({ ...data, confirmationMessage: e.target.value })}
            placeholder="Thank you for reaching out. We'll get back to you soon."
            rows={3}
          />
        </div>
      )}

      <h4 style={{ marginTop: "1.25rem", marginBottom: "0.5rem" }}>Webhook</h4>
      <div className="form-group">
        <label>
          <input
            type="checkbox"
            checked={data.webhookEnabled ?? false}
            onChange={(e) => onDataChange({ ...data, webhookEnabled: e.target.checked })}
          />{" "}
          Send each submission to a webhook URL
        </label>
      </div>
      {data.webhookEnabled && (
        <div className="form-group">
          <label>Webhook URL</label>
          <input
            type="url"
            value={data.webhookUrl ?? ""}
            onChange={(e) => onDataChange({ ...data, webhookUrl: e.target.value })}
            placeholder="https://hooks.example.com/forms"
          />
          <small style={{ color: "#888" }}>
            Must be https. We POST the submission as JSON, signed with your site's webhook secret (Settings → Forms). Find the signing secret there to verify the X-Cadmus-Signature header.
          </small>
        </div>
      )}

      <h4 style={{ marginTop: "1.25rem", marginBottom: "0.5rem" }}>Fields</h4>

      <div className="list-editor-items">
        {fields.map((field, index) => (
          <div key={index} className="list-editor-item">
            <div className="list-item-header">
              <span>Field {index + 1}</span>
              <button
                type="button"
                className="btn btn-sm danger"
                onClick={() => removeField(index)}
              >
                Remove
              </button>
            </div>
            <div className="form-group">
              <label>Name</label>
              <input
                type="text"
                value={field.name}
                onChange={(e) => updateField(index, "name", e.target.value)}
                placeholder="field_name"
              />
            </div>
            <div className="form-group">
              <label>Label{field.type === "checkbox" ? " (agreement text)" : ""}</label>
              <input
                type="text"
                value={field.label}
                onChange={(e) => updateField(index, "label", e.target.value)}
                placeholder={field.type === "checkbox" ? "e.g. I agree to the terms" : "Field Label"}
              />
              {field.type === "checkbox" && (
                <small style={{ color: "#888" }}>Shown next to the checkbox. Mark Required to force agreement before submitting.</small>
              )}
            </div>
            {field.type !== "checkbox" && (
              <div className="form-group">
                <label>Placeholder</label>
                <input
                  type="text"
                  value={field.placeholder ?? ""}
                  onChange={(e) => updateField(index, "placeholder", e.target.value)}
                  placeholder={`Enter your ${field.label.toLowerCase() || "value"}...`}
                />
              </div>
            )}
            <div className="form-group">
              <label>Type</label>
              <select
                value={field.type}
                onChange={(e) => updateField(index, "type", e.target.value)}
              >
                {fieldTypesFor(field.type).map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label>
                <input
                  type="checkbox"
                  checked={field.required ?? false}
                  onChange={(e) => updateField(index, "required", e.target.checked)}
                />{" "}
                Required
              </label>
            </div>
            {field.type === "select" && (
              <div className="form-group">
                <label>Options (comma-separated)</label>
                <input
                  type="text"
                  value={(field.options ?? []).join(", ")}
                  onChange={(e) =>
                    updateField(
                      index,
                      "options",
                      e.target.value.split(",").map((s) => s.trim()).filter(Boolean)
                    )
                  }
                  placeholder="Option 1, Option 2"
                />
              </div>
            )}
          </div>
        ))}
      </div>

      <button type="button" className="btn btn-sm" onClick={addField}>
        + Add Field
      </button>
    </div>
  );
}
