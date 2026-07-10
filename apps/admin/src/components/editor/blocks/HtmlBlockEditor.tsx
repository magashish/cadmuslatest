import { useMemo } from "react";
import type { HtmlBlock } from "@cadmus/shared";
import { HtmlSectionEditor } from "./HtmlSectionEditor";

interface ThemePreview {
  colors?: Record<string, string>;
  fonts?: string[];
  fontFamilies?: Record<string, string[]>;
  borderRadius?: Record<string, string>;
  customCss?: string;
  compiledCss?: string;
  materialSymbols?: boolean;
}

interface Props {
  data: HtmlBlock["data"];
  variant: HtmlBlock["variant"];
  onDataChange: (data: HtmlBlock["data"]) => void;
  onVariantChange: (variant: HtmlBlock["variant"]) => void;
  theme?: ThemePreview;
}

export function HtmlBlockEditor({ data, onDataChange, theme }: Props) {
  const editableFields = data.editableFields ?? {};

  const hasForm = useMemo(() => /<form[\s>]/i.test(data.html), [data.html]);
  const formSettings = data.formSettings ?? {};

  const updateFormSettings = (patch: Partial<NonNullable<HtmlBlock["data"]["formSettings"]>>) => {
    onDataChange({
      ...data,
      formSettings: { ...formSettings, ...patch },
    });
  };

  const formTab = hasForm
    ? [
        {
          key: "form",
          label: "Form Settings",
          content: (
            <div>
              <p style={{ marginBottom: "1rem", fontSize: "0.9rem", color: "var(--color-text-muted)" }}>
                Configure how this form handles submissions. These settings override the site-level defaults.
              </p>

              <div className="form-group">
                <label>Form Name</label>
                <input
                  type="text"
                  value={formSettings.name ?? ""}
                  onChange={(e) => updateFormSettings({ name: e.target.value })}
                  placeholder="e.g. Contact Form, Newsletter Signup"
                />
                <small style={{ color: "#888" }}>Shown on the Forms page to identify submissions</small>
              </div>

              <div className="form-group">
                <label>Notification Email</label>
                <input
                  type="email"
                  value={formSettings.notificationEmail ?? ""}
                  onChange={(e) => updateFormSettings({ notificationEmail: e.target.value })}
                  placeholder="you@example.com"
                />
                <small style={{ color: "#888" }}>Where submission alerts are sent</small>
              </div>

              <div className="form-group">
                <label>Success Message</label>
                <input
                  type="text"
                  value={formSettings.successMessage ?? ""}
                  onChange={(e) => updateFormSettings({ successMessage: e.target.value })}
                  placeholder="Thank you for your submission!"
                />
              </div>

              <div className="form-group">
                <label>Redirect URL</label>
                <input
                  type="text"
                  value={formSettings.redirectUrl ?? ""}
                  onChange={(e) => updateFormSettings({ redirectUrl: e.target.value })}
                  placeholder="https://example.com/thank-you"
                />
                <small style={{ color: "#888" }}>If set, redirects instead of showing the success message</small>
              </div>

              <div className="form-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={formSettings.confirmationEnabled ?? false}
                    onChange={(e) => updateFormSettings({ confirmationEnabled: e.target.checked })}
                  />
                  Send confirmation email to submitter
                </label>
              </div>

              {formSettings.confirmationEnabled && (
                <div className="form-group">
                  <label>Confirmation Message</label>
                  <textarea
                    value={formSettings.confirmationMessage ?? ""}
                    onChange={(e) => updateFormSettings({ confirmationMessage: e.target.value })}
                    placeholder="Thank you for reaching out. We'll get back to you soon."
                    rows={3}
                  />
                </div>
              )}

              <div className="form-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={formSettings.webhookEnabled ?? false}
                    onChange={(e) => updateFormSettings({ webhookEnabled: e.target.checked })}
                  />
                  Send each submission to a webhook URL
                </label>
              </div>

              {formSettings.webhookEnabled && (
                <div className="form-group">
                  <label>Webhook URL</label>
                  <input
                    type="url"
                    value={formSettings.webhookUrl ?? ""}
                    onChange={(e) => updateFormSettings({ webhookUrl: e.target.value })}
                    placeholder="https://hooks.example.com/forms"
                  />
                  <small style={{ color: "#888" }}>
                    Must be https. Submissions are POSTed as signed JSON; the signing secret is in Settings → Forms.
                  </small>
                </div>
              )}
            </div>
          ),
        },
      ]
    : undefined;

  return (
    <HtmlSectionEditor
      html={data.html}
      editableFields={editableFields}
      onHtmlChange={(html) => onDataChange({ ...data, html })}
      onFieldsChange={(editableFields) => onDataChange({ ...data, editableFields })}
      theme={theme}
      sectionName={data.sectionName}
      extraTabs={formTab}
    />
  );
}
