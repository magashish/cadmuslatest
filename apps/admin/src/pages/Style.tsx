import { useState, useEffect, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { site, ai, navigation } from "../lib/api";
import {
  themePresets,
  applyNavToStitchHeader,
  applyNavToStitchFooter,
} from "@cadmus/shared";
import type { DesignStyle, SiteTheme, HtmlBlockEditableField } from "@cadmus/shared";
import { ThemeEditor } from "../components/ThemeEditor";
import { ContentPicker } from "../components/ContentPicker";
import { HtmlSectionEditor } from "../components/editor/blocks/HtmlSectionEditor";
import { MediaPicker } from "../components/MediaPicker";
import { BrandingSection } from "../components/BrandingSection";
import { DesignDirectionSection } from "../components/DesignDirectionSection";

interface SiteData {
  id: string;
  name: string;
  subdomain: string;
  domain?: string;
  brief?: Record<string, string>;
  settings?: Record<string, unknown>;
}

const fontName = (stack: string) =>
  stack.split(",")[0].replace(/['"]/g, "").trim();

interface MenuItem {
  label: string;
  url: string;
  children?: { label: string; url: string }[];
}

function MenuEditor(props: {
  items: MenuItem[];
  onChange: (items: MenuItem[]) => void;
  loaded: boolean;
  location: "header" | "footer";
}) {
  const { items, onChange, loaded, location } = props;
  // Which URL field the page/post picker is targeting (parent row, or a child
  // row when childIndex is set), or null when the picker is closed.
  const [picker, setPicker] = useState<{ parentIndex: number; childIndex?: number } | null>(null);
  const update = (index: number, field: "label" | "url", value: string) =>
    onChange(items.map((item, i) => (i === index ? { ...item, [field]: value } : item)));
  // Apply a picked page/post to the targeted row: always set the URL, and fill
  // the label from the content title only when it's still empty. Done in one
  // onChange so both fields land together.
  const applyPick = (target: { parentIndex: number; childIndex?: number }, url: string, title: string) =>
    onChange(
      items.map((item, i) => {
        if (i !== target.parentIndex) return item;
        if (target.childIndex == null) {
          return { ...item, url, label: item.label || title };
        }
        return {
          ...item,
          children: (item.children ?? []).map((child, ci) =>
            ci === target.childIndex ? { ...child, url, label: child.label || title } : child,
          ),
        };
      }),
    );
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  const add = () => onChange([...items, { label: "", url: "" }]);
  const remove = (index: number) => onChange(items.filter((_, i) => i !== index));

  const addChild = (index: number) =>
    onChange(
      items.map((item, i) =>
        i === index
          ? { ...item, children: [...(item.children ?? []), { label: "", url: "" }] }
          : item,
      ),
    );
  const updateChild = (parentIndex: number, childIndex: number, field: "label" | "url", value: string) =>
    onChange(
      items.map((item, i) =>
        i === parentIndex
          ? {
              ...item,
              children: (item.children ?? []).map((child, ci) =>
                ci === childIndex ? { ...child, [field]: value } : child,
              ),
            }
          : item,
      ),
    );
  const removeChild = (parentIndex: number, childIndex: number) =>
    onChange(
      items.map((item, i) =>
        i === parentIndex
          ? { ...item, children: (item.children ?? []).filter((_, ci) => ci !== childIndex) }
          : item,
      ),
    );

  if (!loaded) return <p style={{ color: "var(--color-text-muted)" }}>Loading menu...</p>;

  return (
    <div>
      <p style={{ marginBottom: "0.75rem", fontSize: "0.85rem", color: "var(--color-text-muted)" }}>
        These items are woven into the {location} at render time. Save them with the {location} below.
        Items with children become dropdown menus; their URL can be left empty if they are labels only.
      </p>
      {items.length === 0 ? (
        <p style={{ color: "var(--color-text-muted)", marginBottom: "0.75rem" }}>No menu items yet.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "0.75rem" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", padding: "0.5rem", borderBottom: "1px solid var(--color-border)" }}>Label</th>
              <th style={{ textAlign: "left", padding: "0.5rem", borderBottom: "1px solid var(--color-border)" }}>URL</th>
              <th style={{ width: "160px", padding: "0.5rem", borderBottom: "1px solid var(--color-border)" }} />
            </tr>
          </thead>
          <tbody>
            {items.map((item, index) => (
              <>
                <tr key={`item-${index}`}>
                  <td style={{ padding: "0.5rem", borderBottom: item.children && item.children.length > 0 ? "none" : "1px solid var(--color-border)" }}>
                    <input
                      type="text"
                      value={item.label}
                      onChange={(e) => update(index, "label", e.target.value)}
                      placeholder="Label"
                      style={{ width: "100%" }}
                    />
                  </td>
                  <td style={{ padding: "0.5rem", borderBottom: item.children && item.children.length > 0 ? "none" : "1px solid var(--color-border)" }}>
                    <div style={{ display: "flex", gap: "0.25rem", alignItems: "center" }}>
                      <input
                        type="text"
                        value={item.url}
                        onChange={(e) => update(index, "url", e.target.value)}
                        placeholder="/path (optional if has children)"
                        style={{ width: "100%" }}
                      />
                      <button
                        type="button"
                        className="btn"
                        style={{ fontSize: "0.75rem", padding: "0.2rem 0.4rem", whiteSpace: "nowrap" }}
                        onClick={() => setPicker({ parentIndex: index })}
                        title="Link to a published page or post"
                      >
                        Page/Post
                      </button>
                    </div>
                  </td>
                  <td style={{ padding: "0.5rem", borderBottom: item.children && item.children.length > 0 ? "none" : "1px solid var(--color-border)", textAlign: "right" }}>
                    <div style={{ display: "flex", gap: "0.25rem", justifyContent: "flex-end" }}>
                      <button type="button" className="btn" style={{ fontSize: "0.75rem", padding: "0.2rem 0.4rem" }} onClick={() => addChild(index)} title="Add child item">+ child</button>
                      <button type="button" className="btn" style={{ fontSize: "0.8rem", padding: "0.25rem 0.5rem" }} onClick={() => move(index, -1)} disabled={index === 0} title="Move up">▲</button>
                      <button type="button" className="btn" style={{ fontSize: "0.8rem", padding: "0.25rem 0.5rem" }} onClick={() => move(index, 1)} disabled={index === items.length - 1} title="Move down">▼</button>
                      <button type="button" className="btn" style={{ fontSize: "0.8rem", padding: "0.25rem 0.5rem" }} onClick={() => remove(index)} title="Remove">✕</button>
                    </div>
                  </td>
                </tr>
                {(item.children ?? []).map((child, childIndex) => (
                  <tr key={`child-${index}-${childIndex}`}>
                    <td style={{ padding: "0.25rem 0.5rem 0.25rem 2rem", borderBottom: childIndex === (item.children!.length - 1) ? "1px solid var(--color-border)" : "none" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                        <span style={{ color: "var(--color-text-muted)", fontSize: "0.8rem" }}>↳</span>
                        <input
                          type="text"
                          value={child.label}
                          onChange={(e) => updateChild(index, childIndex, "label", e.target.value)}
                          placeholder="Child label"
                          style={{ width: "100%", fontSize: "0.875rem" }}
                        />
                      </div>
                    </td>
                    <td style={{ padding: "0.25rem 0.5rem", borderBottom: childIndex === (item.children!.length - 1) ? "1px solid var(--color-border)" : "none" }}>
                      <div style={{ display: "flex", gap: "0.25rem", alignItems: "center" }}>
                        <input
                          type="text"
                          value={child.url}
                          onChange={(e) => updateChild(index, childIndex, "url", e.target.value)}
                          placeholder="/path"
                          style={{ width: "100%", fontSize: "0.875rem" }}
                        />
                        <button
                          type="button"
                          className="btn"
                          style={{ fontSize: "0.7rem", padding: "0.15rem 0.35rem", whiteSpace: "nowrap" }}
                          onClick={() => setPicker({ parentIndex: index, childIndex })}
                          title="Link to a published page or post"
                        >
                          Page/Post
                        </button>
                      </div>
                    </td>
                    <td style={{ padding: "0.25rem 0.5rem", borderBottom: childIndex === (item.children!.length - 1) ? "1px solid var(--color-border)" : "none", textAlign: "right" }}>
                      <button type="button" className="btn" style={{ fontSize: "0.8rem", padding: "0.2rem 0.4rem" }} onClick={() => removeChild(index, childIndex)} title="Remove child">✕</button>
                    </td>
                  </tr>
                ))}
              </>
            ))}
          </tbody>
        </table>
      )}
      <button type="button" className="btn" onClick={add}>+ Add item</button>
      {picker && (
        <ContentPicker
          onSelect={({ url, title }) => {
            applyPick(picker, url, title);
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}

function RecompileCssButton({ siteId }: { siteId: string }) {
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");

  const handleRecompile = async () => {
    if (!siteId) return;
    setStatus("loading");
    try {
      await site.recompileCss(siteId);
      setStatus("done");
      setTimeout(() => setStatus("idle"), 3000);
    } catch {
      setStatus("error");
      setTimeout(() => setStatus("idle"), 3000);
    }
  };

  return (
    <div style={{ marginTop: "0.5rem" }}>
      <button
        type="button"
        className="btn"
        onClick={handleRecompile}
        disabled={status === "loading"}
        style={{ fontSize: "0.8rem" }}
      >
        {status === "loading" ? "Recompiling…" : "Recompile CSS"}
      </button>
      {status === "done" && <span className="settings-success" style={{ marginLeft: "0.75rem" }}>CSS recompiled!</span>}
      {status === "error" && <span className="auth-error" style={{ marginLeft: "0.75rem" }}>Recompile failed</span>}
    </div>
  );
}

export function Style() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [siteData, setSiteData] = useState<SiteData | null>(null);
  const [loading, setLoading] = useState(true);

  // Theme
  const [themeSaved, setThemeSaved] = useState(false);
  const [themeError, setThemeError] = useState("");
  const [theme, setTheme] = useState<SiteTheme | null>(null);
  const [logoUrl, setLogoUrl] = useState<string>("");
  const [showLogoPicker, setShowLogoPicker] = useState(false);
  const [generatingLogo, setGeneratingLogo] = useState(false);
  const [logoGenError, setLogoGenError] = useState("");
  const currentPreset: DesignStyle = theme?.presetSeed ?? "modern";
  const hasCustomTheme = !!(theme && (theme.headerHtml || theme.footerHtml));

  // Header/Footer drafts
  const [headerDraft, setHeaderDraft] = useState<{ html: string; fields: Record<string, HtmlBlockEditableField> } | null>(null);
  const [footerDraft, setFooterDraft] = useState<{ html: string; fields: Record<string, HtmlBlockEditableField> } | null>(null);
  const [headerSaving, setHeaderSaving] = useState(false);
  const [footerSaving, setFooterSaving] = useState(false);
  const [headerSaved, setHeaderSaved] = useState(false);
  const [footerSaved, setFooterSaved] = useState(false);
  const [headerError, setHeaderError] = useState("");
  const [footerError, setFooterError] = useState("");

  // Menus
  const [headerMenu, setHeaderMenu] = useState<MenuItem[]>([]);
  const [footerMenu, setFooterMenu] = useState<MenuItem[]>([]);
  const [menuLoaded, setMenuLoaded] = useState(false);

  const loadSite = useCallback(async () => {
    if (!user) return;
    try {
      const s = await site.get(user.siteId);
      const data = s as SiteData;
      setSiteData(data);
      const settings = (s as Record<string, unknown>).settings as Record<string, unknown> | undefined;
      if (settings?.theme) {
        const st = settings.theme as SiteTheme;
        setTheme(st);
        if (st.headerHtml || st.footerHtml) {
          setHeaderDraft({ html: st.headerHtml ?? "", fields: st.headerEditableFields ?? {} });
          setFooterDraft({ html: st.footerHtml ?? "", fields: st.footerEditableFields ?? {} });
        }
      }
      if (settings?.logoUrl) {
        setLogoUrl(settings.logoUrl as string);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [user]);

  const loadMenus = useCallback(async () => {
    if (!user) return;
    try {
      const [h, f] = await Promise.all([navigation.list("header"), navigation.list("footer")]);
      setHeaderMenu(h.items[0]?.items ?? []);
      setFooterMenu(f.items[0]?.items ?? []);
    } catch {
      // ignore
    } finally {
      setMenuLoaded(true);
    }
  }, [user]);

  useEffect(() => {
    loadSite();
  }, [loadSite]);

  useEffect(() => {
    loadMenus();
  }, [loadMenus]);

  useEffect(() => {
    const handler = () => {
      loadSite();
      loadMenus();
    };
    window.addEventListener("cadmus:content-updated", handler);
    return () => window.removeEventListener("cadmus:content-updated", handler);
  }, [loadSite, loadMenus]);

  const saveTheme = async (preset: DesignStyle) => {
    if (!siteData) return;
    setThemeError("");
    setThemeSaved(false);
    const nextTheme: SiteTheme = { ...themePresets[preset], presetSeed: preset };
    setTheme(nextTheme);
    try {
      const existingSettings = (siteData as unknown as Record<string, unknown>).settings as Record<string, unknown> | undefined;
      await site.update(siteData.id, {
        settings: { ...existingSettings, theme: nextTheme },
      });
      setThemeSaved(true);
      setTimeout(() => setThemeSaved(false), 3000);
    } catch (e) {
      setThemeError(e instanceof Error ? e.message : "Failed to save theme");
    }
  };

  const headerPreviewTransform = useMemo(
    () => (html: string) =>
      applyNavToStitchHeader(html, headerMenu, siteData?.name ?? "", "/", logoUrl || undefined),
    [headerMenu, siteData?.name, logoUrl],
  );

  const footerPreviewTransform = useMemo(
    () => (html: string) =>
      applyNavToStitchFooter(
        html,
        footerMenu,
        siteData?.name ?? "",
        new Date().getFullYear(),
        undefined,
        logoUrl || undefined,
      ),
    [footerMenu, siteData?.name, logoUrl],
  );

  if (loading) {
    return (
      <div className="page">
        <h2>Style</h2>
        <p>Loading...</p>
      </div>
    );
  }

  return (
    <div className="page">
      <h2>Style</h2>

      {/* Theme */}
      <section className="settings-section">
        <h3>Theme</h3>

        <div className="settings-form" style={{ marginBottom: "1.5rem" }}>
          <label>Site Logo</label>
          <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
            {logoUrl ? (
              <img src={logoUrl} alt="Site logo" style={{ height: 48, width: "auto", borderRadius: 4, background: "#f1f5f9", padding: 4 }} />
            ) : (
              <span style={{ color: "#9ca3af", fontSize: "0.875rem" }}>No logo set</span>
            )}
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button type="button" className="btn" onClick={() => setShowLogoPicker(true)} disabled={generatingLogo}>
                {logoUrl ? "Change" : "Upload"}
              </button>
              <button
                type="button"
                className="btn"
                disabled={generatingLogo}
                onClick={async () => {
                  if (!siteData) return;
                  setGeneratingLogo(true);
                  setLogoGenError("");
                  try {
                    const res = await ai.generateLogo();
                    setLogoUrl(res.url);
                    const existingSettings = (siteData as unknown as Record<string, unknown>).settings as Record<string, unknown> | undefined;
                    await site.update(siteData.id, { settings: { ...existingSettings, logoUrl: res.url } });
                  } catch (e) {
                    setLogoGenError(e instanceof Error ? e.message : "Generation failed");
                  } finally {
                    setGeneratingLogo(false);
                  }
                }}
              >
                {generatingLogo ? "Generating…" : logoUrl ? "Re-roll with AI" : "Generate with AI"}
              </button>
              {logoUrl && (
                <button
                  type="button"
                  className="btn"
                  style={{ color: "#dc2626" }}
                  disabled={generatingLogo}
                  onClick={async () => {
                    if (!siteData) return;
                    const existingSettings = (siteData as unknown as Record<string, unknown>).settings as Record<string, unknown> | undefined;
                    await site.update(siteData.id, { settings: { ...existingSettings, logoUrl: null } });
                    setLogoUrl("");
                  }}
                >
                  Remove
                </button>
              )}
            </div>
          </div>
          {logoGenError && (
            <p style={{ fontSize: "0.8rem", color: "#dc2626", margin: "0.4rem 0 0" }}>{logoGenError}</p>
          )}
          <p style={{ fontSize: "0.8rem", color: "var(--color-text-muted)", margin: "0.4rem 0 0" }}>
            AI generates a simple brand icon (no lettering). Upload your own anytime.
          </p>
          {showLogoPicker && (
            <MediaPicker
              onSelect={async (url) => {
                setShowLogoPicker(false);
                setLogoUrl(url);
                if (!siteData) return;
                const existingSettings = (siteData as unknown as Record<string, unknown>).settings as Record<string, unknown> | undefined;
                await site.update(siteData.id, { settings: { ...existingSettings, logoUrl: url } });
              }}
              onClose={() => setShowLogoPicker(false)}
            />
          )}
        </div>

        {hasCustomTheme && theme ? (
          <>
            <ThemeEditor
              theme={theme}
              onSave={async (updated) => {
                if (!siteData) return;
                const existingSettings = (siteData as unknown as Record<string, unknown>).settings as Record<string, unknown> | undefined;
                await site.update(siteData.id, {
                  settings: { ...existingSettings, theme: updated },
                });
                setTheme(updated);
              }}
            />
            {new URLSearchParams(window.location.search).get("debug") === "true" && (
              <RecompileCssButton siteId={siteData?.id ?? ""} />
            )}
          </>
        ) : (
          <>
            <p style={{ marginBottom: "1rem" }}>Choose a visual theme for your public-facing site.</p>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
                gap: "1rem",
              }}
            >
              {(Object.keys(themePresets) as DesignStyle[]).map((key) => {
                const preset = themePresets[key];
                const isSelected = currentPreset === key;
                return (
                  <button
                    key={key}
                    onClick={() => saveTheme(key)}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "0.5rem",
                      padding: "1rem",
                      border: isSelected ? "2px solid var(--color-primary)" : "2px solid var(--color-border, #e2e8f0)",
                      borderRadius: "8px",
                      background: "var(--color-surface, #f8fafc)",
                      cursor: "pointer",
                      textAlign: "left",
                      transition: "border-color 0.15s",
                    }}
                  >
                    <span style={{ fontWeight: 600, textTransform: "capitalize", fontSize: "0.95rem" }}>
                      {key}
                    </span>
                    <span style={{ display: "flex", gap: "4px" }}>
                      {[preset.colors.primary, preset.colors.accent, preset.colors.background, preset.colors.text].map(
                        (color, i) => (
                          <span
                            key={i}
                            style={{
                              width: "20px",
                              height: "20px",
                              borderRadius: "4px",
                              backgroundColor: color,
                              border: "1px solid rgba(0,0,0,0.1)",
                            }}
                          />
                        )
                      )}
                    </span>
                    <span style={{ fontSize: "0.8rem", color: "var(--color-text-muted, #64748b)" }}>
                      {fontName(preset.fontFamilies.heading?.[0] ?? "")}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="settings-actions" style={{ marginTop: "0.75rem" }}>
              {themeSaved && <span className="settings-success">Saved!</span>}
              {themeError && <span className="auth-error">{themeError}</span>}
            </div>
          </>
        )}
      </section>

      {/* Header & Footer */}
      {theme && headerDraft && footerDraft && (
        <section className="settings-section">
          <h3>Header &amp; Footer</h3>
          <p style={{ marginBottom: "0.75rem", color: "var(--color-text-muted)" }}>
            Edit the header and footer sections of your theme. Navigation links and logo are wired up automatically — edit layout, copy, and menu items here.
          </p>

          <div style={{ marginBottom: "2rem" }}>
            <h4 style={{ marginBottom: "0.75rem" }}>Header</h4>
            <HtmlSectionEditor
              html={headerDraft.html}
              editableFields={headerDraft.fields}
              onHtmlChange={(html) => setHeaderDraft({ ...headerDraft, html })}
              onFieldsChange={(fields) => setHeaderDraft({ ...headerDraft, fields })}
              theme={theme}
              previewHeight={200}
              previewTransform={headerPreviewTransform}
              extraTabs={[
                {
                  key: "menu",
                  label: `Menu (${headerMenu.length})`,
                  content: (
                    <MenuEditor
                      items={headerMenu}
                      onChange={setHeaderMenu}
                      loaded={menuLoaded}
                      location="header"
                    />
                  ),
                },
              ]}
            />
            <div className="settings-actions" style={{ marginTop: "0.75rem" }}>
              <button
                className="btn btn-primary"
                disabled={headerSaving}
                onClick={async () => {
                  if (!siteData || !theme) return;
                  setHeaderError("");
                  setHeaderSaved(false);
                  setHeaderSaving(true);
                  try {
                    const updated: SiteTheme = {
                      ...theme,
                      headerHtml: headerDraft.html,
                      headerEditableFields: headerDraft.fields,
                    };
                    const existingSettings = (siteData as unknown as Record<string, unknown>).settings as Record<string, unknown> | undefined;
                    await Promise.all([
                      site.update(siteData.id, {
                        settings: { ...existingSettings, theme: updated },
                      }),
                      navigation.upsert("header", headerMenu, user?.id),
                    ]);
                    setTheme(updated);
                    setHeaderSaved(true);
                    setTimeout(() => setHeaderSaved(false), 3000);
                  } catch (e) {
                    setHeaderError(e instanceof Error ? e.message : "Failed to save header");
                  } finally {
                    setHeaderSaving(false);
                  }
                }}
              >
                {headerSaving ? "Saving..." : "Save header"}
              </button>
              {headerSaved && <span className="settings-success">Saved!</span>}
              {headerError && <span className="auth-error">{headerError}</span>}
            </div>
          </div>

          <div>
            <h4 style={{ marginBottom: "0.75rem" }}>Footer</h4>
            <HtmlSectionEditor
              html={footerDraft.html}
              editableFields={footerDraft.fields}
              onHtmlChange={(html) => setFooterDraft({ ...footerDraft, html })}
              onFieldsChange={(fields) => setFooterDraft({ ...footerDraft, fields })}
              theme={theme}
              previewHeight={300}
              previewTransform={footerPreviewTransform}
              extraTabs={[
                {
                  key: "menu",
                  label: `Menu (${footerMenu.length})`,
                  content: (
                    <MenuEditor
                      items={footerMenu}
                      onChange={setFooterMenu}
                      loaded={menuLoaded}
                      location="footer"
                    />
                  ),
                },
              ]}
            />
            <div className="settings-actions" style={{ marginTop: "0.75rem" }}>
              <button
                className="btn btn-primary"
                disabled={footerSaving}
                onClick={async () => {
                  if (!siteData || !theme) return;
                  setFooterError("");
                  setFooterSaved(false);
                  setFooterSaving(true);
                  try {
                    const updated: SiteTheme = {
                      ...theme,
                      footerHtml: footerDraft.html,
                      footerEditableFields: footerDraft.fields,
                    };
                    const existingSettings = (siteData as unknown as Record<string, unknown>).settings as Record<string, unknown> | undefined;
                    await Promise.all([
                      site.update(siteData.id, {
                        settings: { ...existingSettings, theme: updated },
                      }),
                      navigation.upsert("footer", footerMenu, user?.id),
                    ]);
                    setTheme(updated);
                    setFooterSaved(true);
                    setTimeout(() => setFooterSaved(false), 3000);
                  } catch (e) {
                    setFooterError(e instanceof Error ? e.message : "Failed to save footer");
                  } finally {
                    setFooterSaving(false);
                  }
                }}
              >
                {footerSaving ? "Saving..." : "Save footer"}
              </button>
              {footerSaved && <span className="settings-success">Saved!</span>}
              {footerError && <span className="auth-error">{footerError}</span>}
            </div>
          </div>
        </section>
      )}

      <BrandingSection />

      {(user?.role === "owner" || user?.role === "admin") && <DesignDirectionSection />}
    </div>
  );
}
