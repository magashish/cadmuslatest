import { useMemo, useEffect, useRef, useState, type ReactNode } from "react";
import type { HtmlBlockEditableField } from "@cadmus/shared";
import { applyEditableFields, backfillFieldsFromMarkers } from "@cadmus/shared";
import { MediaPicker } from "../../MediaPicker";

function computeOnColor(hex: string): string {
  const c = hex.replace("#", "");
  const r = parseInt(c.slice(0, 2), 16) / 255;
  const g = parseInt(c.slice(2, 4), 16) / 255;
  const b = parseInt(c.slice(4, 6), 16) / 255;
  const lum = (x: number) => x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  const L = 0.2126 * lum(r) + 0.7152 * lum(g) + 0.0722 * lum(b);
  return L > 0.179 ? "#1a1a1a" : "#ffffff";
}

interface ThemePreview {
  colors?: Record<string, string>;
  fonts?: string[];
  fontFamilies?: Record<string, string[]>;
  borderRadius?: Record<string, string>;
  customCss?: string;
  compiledCss?: string;
  materialSymbols?: boolean;
}

export interface HtmlSectionEditorProps {
  html: string;
  editableFields: Record<string, HtmlBlockEditableField>;
  onHtmlChange: (html: string) => void;
  onFieldsChange: (fields: Record<string, HtmlBlockEditableField>) => void;
  theme?: ThemePreview;
  sectionName?: string;
  previewHeight?: number;
  extraTabs?: Array<{ key: string; label: string; content: ReactNode }>;
  initialTab?: "preview" | "fields" | "html" | string;
  // Optional final pass applied to the HTML after editable fields are merged,
  // before building the preview iframe. Use to apply render-time wiring such
  // as navigation and social links so the preview matches the public site.
  previewTransform?: (html: string) => string;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

function injectAndReplace(
  html: string,
  fieldId: string,
  field: HtmlBlockEditableField,
  allFields?: Record<string, HtmlBlockEditableField>,
): string {
  if (field.type === "image") return html;

  if (field.type === "link") {
    const linkPattern = /<(a|button)(\s[^>]*)?>([^]*?)<\/\1>/gi;
    let match;
    while ((match = linkPattern.exec(html)) !== null) {
      const tagName = match[1];
      const attrs = match[2] || "";
      const innerContent = match[3];
      if (attrs.includes("data-cadmus-field")) continue;
      if (tagName === "a") {
        const hrefMatch = attrs.match(/href="([^"]*)"/);
        if (hrefMatch && hrefMatch[1] === field.value) {
          const original = match[0];
          const markedTag = `<${tagName}${attrs} data-cadmus-field="${fieldId}">${innerContent}</${tagName}>`;
          return html.replace(original, markedTag);
        }
      }
      if (tagName === "button" && allFields) {
        const textFieldId = fieldId.replace(/-link$/, "-text");
        const textField = allFields[textFieldId];
        if (textField && norm(innerContent.replace(/<[^>]*>/g, "")) === norm(textField.value)) {
          const original = match[0];
          const markedTag = `<${tagName}${attrs} data-cadmus-field="${fieldId}">${innerContent}</${tagName}>`;
          return html.replace(original, markedTag);
        }
      }
    }
    return html;
  }

  const normalizedValue = norm(field.value);
  const tagPattern = /<(h[1-6]|p|span|a|button|li)(\s[^>]*)?>([^]*?)<\/\1>/gi;
  let match;
  while ((match = tagPattern.exec(html)) !== null) {
    const tagName = match[1];
    const attrs = match[2] || "";
    const innerContent = match[3];
    if (attrs.includes("data-cadmus-field")) continue;
    if (norm(innerContent.replace(/<[^>]*>/g, "")) === normalizedValue) {
      const original = match[0];
      const markedTag = `<${tagName}${attrs} data-cadmus-field="${fieldId}">${innerContent}</${tagName}>`;
      return html.replace(original, markedTag);
    }
  }

  return html;
}

export function buildEditablePreview(
  html: string,
  editableFields: Record<string, HtmlBlockEditableField>,
  theme?: ThemePreview,
  previewTransform?: (html: string) => string,
): string {
  let applied = applyEditableFields(html, editableFields);

  if (previewTransform) {
    applied = previewTransform(applied);
  }

  const fontLinks = (theme?.fonts ?? [])
    .map((url) => `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="${url}">`)
    .join("\n");

  const materialSymbolsLink = theme?.materialSymbols
    ? '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200">'
    : "";

  let cssBlock: string;
  if (theme?.compiledCss) {
    cssBlock = `<style>${theme.compiledCss}</style>`;
  } else {
    const twConfig = theme?.colors
      ? JSON.stringify({
          theme: {
            extend: {
              colors: theme.colors,
              fontFamily: theme.fontFamilies ?? {},
              borderRadius: theme.borderRadius ?? {},
            },
          },
        })
      : "{}";
    cssBlock = `<script src="https://cdn.tailwindcss.com"><\/script>
<script>tailwind.config = ${twConfig};<\/script>`;
  }

  const customCss = theme?.customCss ? `<style>${theme.customCss}</style>` : "";

  // Inject CSS custom properties so Claude-designed sections (which use
  // var(--color-primary) etc. via inline styles) render correctly in preview.
  const c = theme?.colors ?? {};
  const ff = theme?.fontFamilies ?? {};
  const headingFont = Array.isArray(ff.heading) ? ff.heading.join(", ") : (ff.heading ?? "system-ui");
  const bodyFont = Array.isArray(ff.body) ? ff.body.join(", ") : (ff.body ?? "system-ui");
  const primaryHex = c.primary ?? "#1a1a1a";
  const onPrimary = c.onPrimary ?? computeOnColor(primaryHex);
  const cssVars = [
    `--color-primary: ${primaryHex}`,
    `--color-on-primary: ${onPrimary}`,
    `--color-accent: ${c.accent ?? primaryHex}`,
    `--color-bg: ${c.background ?? "#ffffff"}`,
    `--color-text: ${c.text ?? c["on-surface"] ?? "#1a1a1a"}`,
    `--color-text-muted: ${c.textMuted ?? c["on-surface-variant"] ?? "#64748b"}`,
    `--font-heading: ${headingFont}`,
    `--font-body: ${bodyFont}`,
  ].join("; ");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${fontLinks}
  ${materialSymbolsLink}
  ${cssBlock}
  ${customCss}
  <style>:root { ${cssVars} } body { margin: 0; }</style>
</head>
<body>${applied}</body>
</html>`;
}

export function HtmlSectionEditor({
  html,
  editableFields,
  onHtmlChange,
  onFieldsChange,
  theme,
  sectionName,
  previewHeight = 400,
  extraTabs,
  initialTab = "preview",
  previewTransform,
}: HtmlSectionEditorProps) {
  const [activeTab, setActiveTab] = useState<string>(initialTab);
  const [mediaPickerFieldId, setMediaPickerFieldId] = useState<string | null>(null);
  const fieldEntries = Object.entries(editableFields);
  const htmlDirty = useRef(false);

  const switchToFields = () => {
    if (htmlDirty.current) {
      const next = backfillFieldsFromMarkers(html, editableFields);
      if (next !== editableFields) onFieldsChange(next);
      htmlDirty.current = false;
    }
    setActiveTab("fields");
  };

  const markerFixApplied = useRef(false);
  useEffect(() => {
    if (markerFixApplied.current) return;
    const missingMarkers = Object.keys(editableFields).filter(
      (id) => !html.includes(`data-cadmus-field="${id}"`),
    );
    if (missingMarkers.length === 0) return;
    markerFixApplied.current = true;

    let next = html;
    for (const fieldId of missingMarkers) {
      next = injectAndReplace(next, fieldId, editableFields[fieldId], editableFields);
    }
    if (next !== html) onHtmlChange(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fieldBackfillApplied = useRef(false);
  useEffect(() => {
    if (fieldBackfillApplied.current) return;
    fieldBackfillApplied.current = true;
    const next = backfillFieldsFromMarkers(html, editableFields);
    if (next !== editableFields) onFieldsChange(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateField = (fieldId: string, value: string) => {
    onFieldsChange({
      ...editableFields,
      [fieldId]: { ...editableFields[fieldId], value },
    });
  };

  const VOID_TAGS = new Set(["img", "input", "br", "hr", "meta", "link", "source", "area", "embed"]);

  const removeField = (fieldId: string) => {
    const attrPattern = `data-cadmus-field="${fieldId}"`;
    const tagMatch = html.match(new RegExp(`<(\\w+)[^>]*${attrPattern}`));
    let nextHtml = html;
    if (tagMatch) {
      const tagName = tagMatch[1];
      const re = VOID_TAGS.has(tagName.toLowerCase())
        ? new RegExp(`<${tagName}[^>]*${attrPattern}[^>]*\\/?>`, "i")
        : new RegExp(`<${tagName}[^>]*${attrPattern}[^>]*>[\\s\\S]*?<\\/${tagName}>`, "i");
      nextHtml = html.replace(re, "");
    }
    if (nextHtml !== html) onHtmlChange(nextHtml);
    const nextFields = { ...editableFields };
    delete nextFields[fieldId];
    onFieldsChange(nextFields);
  };

  const previewHtml = useMemo(
    () => buildEditablePreview(html, editableFields, theme, previewTransform),
    [html, editableFields, theme, previewTransform],
  );

  return (
    <div>
      {sectionName && (
        <div style={{ marginBottom: "0.75rem" }}>
          <span
            style={{
              fontSize: "0.75rem",
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              color: "var(--color-text-muted, #888)",
            }}
          >
            {sectionName}
          </span>
        </div>
      )}

      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.75rem" }}>
        <button
          type="button"
          className={`variant-chip${activeTab === "preview" ? " active" : ""}`}
          onClick={() => setActiveTab("preview")}
        >
          Preview
        </button>
        <button
          type="button"
          className={`variant-chip${activeTab === "fields" ? " active" : ""}`}
          onClick={switchToFields}
        >
          Edit Fields ({fieldEntries.length})
        </button>
        <button
          type="button"
          className={`variant-chip${activeTab === "html" ? " active" : ""}`}
          onClick={() => setActiveTab("html")}
        >
          Edit HTML
        </button>
        {extraTabs?.map((tab) => (
          <button
            key={tab.key}
            type="button"
            className={`variant-chip${activeTab === tab.key ? " active" : ""}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "preview" && (
        <div
          style={{
            border: "1px solid var(--color-border, #e5e7eb)",
            borderRadius: "0.5rem",
            overflow: "hidden",
          }}
        >
          <iframe
            // Key on the content so the iframe remounts when previewHtml
            // changes — browsers don't reliably reload the document when the
            // srcdoc attribute is updated after mount, which left the preview
            // blank on first load until a tab switch forced a remount.
            key={previewHtml}
            srcDoc={previewHtml}
            title={sectionName || "HTML Preview"}
            style={{
              width: "100%",
              height: `${previewHeight}px`,
              border: "none",
              background: "#fff",
            }}
            sandbox="allow-scripts"
          />
        </div>
      )}

      {activeTab === "fields" && (
        <div>
          {fieldEntries.length === 0 ? (
            <p style={{ color: "var(--color-text-muted)", fontSize: "0.875rem" }}>
              No editable fields detected in this section. Add <code>data-cadmus-field="your-id"</code> attributes in the HTML tab to expose fields here.
            </p>
          ) : (
            fieldEntries.map(([fieldId, field]) => (
              <div key={fieldId} className="form-group">
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.5rem" }}>
                  <label style={{ margin: 0 }}>{field.label}</label>
                  <button
                    type="button"
                    className="btn"
                    style={{ fontSize: "0.75rem", padding: "0.15rem 0.5rem", color: "#dc2626" }}
                    title="Remove this field and delete its element from the HTML"
                    onClick={() => {
                      if (window.confirm(`Remove "${field.label}" and delete it from the HTML? This can be undone by discarding changes before saving.`)) {
                        removeField(fieldId);
                      }
                    }}
                  >
                    ✕ Remove
                  </button>
                </div>
                {field.type === "image" ? (
                  <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                    <input
                      type="url"
                      value={field.value}
                      onChange={(e) => updateField(fieldId, e.target.value)}
                      placeholder="Image URL..."
                      style={{ flex: 1 }}
                    />
                    <button
                      className="btn btn-sm"
                      type="button"
                      onClick={() => setMediaPickerFieldId(fieldId)}
                    >
                      Browse
                    </button>
                  </div>
                ) : field.type === "link" ? (
                  <input
                    type="url"
                    value={field.value}
                    onChange={(e) => updateField(fieldId, e.target.value)}
                    placeholder="/page-slug or https://..."
                  />
                ) : field.type === "richtext" ? (
                  <textarea
                    rows={4}
                    value={field.value}
                    onChange={(e) => updateField(fieldId, e.target.value)}
                    placeholder="Enter content..."
                  />
                ) : (
                  <input
                    type="text"
                    value={field.value}
                    onChange={(e) => updateField(fieldId, e.target.value)}
                    placeholder="Enter text..."
                  />
                )}
                <span
                  style={{
                    fontSize: "0.7rem",
                    color: "var(--color-text-muted, #999)",
                  }}
                >
                  {field.type} &middot; {fieldId}
                </span>
              </div>
            ))
          )}
        </div>
      )}

      {activeTab === "html" && (
        <div>
          <p style={{ marginBottom: "0.5rem", fontSize: "0.8rem", color: "var(--color-text-muted)" }}>
            Edit the raw HTML for this section. Changes will be reflected in the preview.
          </p>
          <textarea
            value={html}
            onChange={(e) => {
              const nextHtml = e.target.value;
              onHtmlChange(nextHtml);
              htmlDirty.current = true;
              // Prune fields whose markers are no longer present (user deleted
              // the element). Only touches fields that previously had markers,
              // so ongoing marker-less fields aren't affected.
              const orphaned = Object.keys(editableFields).filter(
                (id) =>
                  html.includes(`data-cadmus-field="${id}"`) &&
                  !nextHtml.includes(`data-cadmus-field="${id}"`),
              );
              if (orphaned.length > 0) {
                const nextFields = { ...editableFields };
                for (const id of orphaned) delete nextFields[id];
                onFieldsChange(nextFields);
              }
            }}
            rows={20}
            style={{
              width: "100%",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              fontSize: "0.8rem",
              lineHeight: 1.5,
              padding: "0.75rem",
              border: "1px solid var(--color-border, #e5e7eb)",
              borderRadius: "0.375rem",
              background: "var(--color-surface, #f8fafc)",
              resize: "vertical",
              tabSize: 2,
            }}
            spellCheck={false}
          />
        </div>
      )}

      {extraTabs?.map((tab) =>
        activeTab === tab.key ? <div key={tab.key}>{tab.content}</div> : null,
      )}

      {mediaPickerFieldId && (
        <MediaPicker
          onSelect={(url) => {
            updateField(mediaPickerFieldId, url);
            setMediaPickerFieldId(null);
          }}
          onClose={() => setMediaPickerFieldId(null)}
        />
      )}
    </div>
  );
}
