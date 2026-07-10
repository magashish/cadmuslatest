import { useState } from "react";
import type { SiteTheme } from "@cadmus/shared";

interface Props {
  theme: SiteTheme;
  onSave: (updated: SiteTheme) => Promise<void>;
}

// Group color tokens by prefix for readability
const COLOR_GROUPS: Array<{ label: string; match: (key: string) => boolean }> = [
  { label: "Primary", match: (k) => k.startsWith("primary") || k.startsWith("on-primary") || k === "inverse-primary" },
  { label: "Secondary", match: (k) => k.startsWith("secondary") || k.startsWith("on-secondary") },
  { label: "Tertiary", match: (k) => k.startsWith("tertiary") || k.startsWith("on-tertiary") },
  { label: "Surface", match: (k) => k.startsWith("surface") || k.startsWith("on-surface") || k.startsWith("inverse") },
  { label: "Error", match: (k) => k.startsWith("error") || k.startsWith("on-error") },
  { label: "Other", match: () => true },
];

function groupColors(colors: Record<string, string>) {
  const assigned = new Set<string>();
  const groups: Array<{ label: string; entries: Array<[string, string]> }> = [];

  for (const group of COLOR_GROUPS) {
    const entries: Array<[string, string]> = [];
    for (const [key, value] of Object.entries(colors)) {
      if (!assigned.has(key) && group.match(key)) {
        entries.push([key, value]);
        assigned.add(key);
      }
    }
    if (entries.length > 0) {
      groups.push({ label: group.label, entries });
    }
  }
  return groups;
}

// Popular Google Fonts grouped by style
const FONT_OPTIONS = [
  "Abril Fatface", "Albert Sans", "Anton", "Archivo Black",
  "Barlow Condensed", "Bebas Neue", "Bitter",
  "Comfortaa", "Cormorant Garamond", "Crimson Text",
  "DM Sans", "DM Serif Display",
  "EB Garamond",
  "Figtree", "Fira Code", "Fredoka",
  "IBM Plex Mono", "Inter",
  "JetBrains Mono",
  "Lato", "Libre Baskerville", "Lora",
  "Manrope", "Merriweather", "Montserrat",
  "Noto Sans", "Noto Serif", "Nunito",
  "Open Sans", "Oswald", "Outfit",
  "Pacifico", "Playfair Display", "Plus Jakarta Sans", "Poppins", "PT Serif",
  "Raleway", "Righteous", "Roboto",
  "Sora", "Source Code Pro", "Source Sans 3", "Source Serif 4", "Space Mono", "Spectral",
  "Urbanist",
  "Work Sans",
];

function formatLabel(key: string): string {
  return key
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function ThemeEditor({ theme, onSave }: Props) {
  const [colors, setColors] = useState<Record<string, string>>({ ...theme.colors });
  const [fontFamilies, setFontFamilies] = useState<Record<string, string[]>>({
    ...Object.fromEntries(
      Object.entries(theme.fontFamilies).map(([k, v]) => [k, [...v]]),
    ),
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);

  const updateColor = (key: string, value: string) => {
    setColors((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
    setSaved(false);
  };

  const updateFont = (key: string, value: string) => {
    setFontFamilies((prev) => ({ ...prev, [key]: [value] }));
    setDirty(true);
    setSaved(false);
  };

  const handleSave = async () => {
    setSaving(true);
    setError("");
    try {
      await onSave({ ...theme, colors, fontFamilies });
      setSaved(true);
      setDirty(false);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const groups = groupColors(colors);

  return (
    <div>
      <p style={{ marginBottom: "1rem", color: "var(--color-text-muted, #64748b)" }}>
        Colors and fonts for your site theme. Edit any value and save.
      </p>

      {/* Color groups */}
      {groups.map((group) => (
        <div key={group.label} style={{ marginBottom: "1.5rem" }}>
          <h4 style={{ fontSize: "0.85rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-muted)", marginBottom: "0.5rem" }}>
            {group.label}
          </h4>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: "0.5rem" }}>
            {group.entries.map(([key, value]) => (
              <label
                key={key}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                  padding: "0.4rem 0.6rem",
                  borderRadius: "6px",
                  border: "1px solid var(--color-border, #e2e8f0)",
                  background: "var(--color-surface, #f8fafc)",
                  cursor: "pointer",
                  fontSize: "0.8rem",
                }}
              >
                <input
                  type="color"
                  value={value}
                  onChange={(e) => updateColor(key, e.target.value)}
                  style={{
                    width: "28px",
                    height: "28px",
                    border: "1px solid rgba(0,0,0,0.15)",
                    borderRadius: "4px",
                    padding: 0,
                    cursor: "pointer",
                    flexShrink: 0,
                  }}
                />
                <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                  <span style={{ fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {formatLabel(key)}
                  </span>
                  <span style={{ color: "var(--color-text-muted)", fontSize: "0.7rem", fontFamily: "monospace" }}>
                    {value}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </div>
      ))}

      {/* Font families */}
      <div style={{ marginBottom: "1.5rem" }}>
        <h4 style={{ fontSize: "0.85rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-muted)", marginBottom: "0.5rem" }}>
          Fonts
        </h4>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: "0.75rem" }}>
          {Object.entries(fontFamilies).map(([key, fonts]) => {
            const current = fonts[0] || "";
            const currentInList = FONT_OPTIONS.some((f) => f.toLowerCase() === current.toLowerCase());
            return (
              <div key={key} className="form-group" style={{ margin: 0 }}>
                <label style={{ fontSize: "0.8rem", fontWeight: 600, textTransform: "capitalize" }}>{key}</label>
                <select
                  value={current}
                  onChange={(e) => updateFont(key, e.target.value)}
                  style={{ fontSize: "0.9rem", fontFamily: current ? `"${current}", sans-serif` : undefined }}
                >
                  {!currentInList && current && (
                    <option value={current} style={{ fontFamily: `"${current}", sans-serif` }}>
                      {current}
                    </option>
                  )}
                  {FONT_OPTIONS.map((font) => (
                    <option key={font} value={font} style={{ fontFamily: `"${font}", sans-serif` }}>
                      {font}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
      </div>

      {/* Save */}
      <div className="settings-actions">
        <button
          className="btn btn-primary"
          onClick={handleSave}
          disabled={!dirty || saving}
          style={{ opacity: dirty ? 1 : 0.5 }}
        >
          {saving ? "Saving..." : "Save Theme"}
        </button>
        {saved && <span className="settings-success">Saved!</span>}
        {error && <span className="auth-error">{error}</span>}
      </div>
    </div>
  );
}
