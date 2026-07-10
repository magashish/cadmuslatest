import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { content } from "../lib/api";

interface ContentItem {
  id: string;
  type: "page" | "post";
  slug: string;
  schemaData?: { title?: string };
}

interface Props {
  // Returns the public path for the chosen content plus its title (so the
  // caller can default an empty menu label).
  onSelect: (selection: { url: string; title: string }) => void;
  onClose: () => void;
}

// Mirrors the page/post routing in apps/web: pages live at /<slug> (with the
// "home" page at /), posts at /blog/<slug>.
function contentUrl(type: "page" | "post", slug: string): string {
  if (slug === "home") return "/";
  return type === "post" ? `/blog/${slug}` : `/${slug}`;
}

export function ContentPicker({ onSelect, onClose }: Props) {
  const { t } = useTranslation();
  const [type, setType] = useState<"page" | "post">("page");
  const [items, setItems] = useState<ContentItem[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await content.list(type, "published");
      setItems(res.items as ContentItem[]);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [type]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="block-picker-overlay" onClick={onClose}>
      <div className="media-picker" onClick={(e) => e.stopPropagation()}>
        <div className="page-header">
          <h3>{t("contentPicker.title")}</h3>
        </div>

        <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.75rem" }}>
          {(["page", "post"] as const).map((ct) => (
            <button
              key={ct}
              type="button"
              className="btn"
              onClick={() => setType(ct)}
              style={{
                fontWeight: type === ct ? 600 : 400,
                borderBottom: type === ct ? "2px solid var(--color-primary)" : undefined,
              }}
            >
              {ct === "page" ? t("contentPicker.tabs.pages") : t("contentPicker.tabs.posts")}
            </button>
          ))}
        </div>

        {loading ? (
          <p>{t("common.loading")}</p>
        ) : items.length === 0 ? (
          <p style={{ color: "var(--color-text-muted)" }}>
            {type === "page" ? t("contentPicker.noPublished.pages") : t("contentPicker.noPublished.posts")}
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
            {items.map((item) => {
              const title = item.schemaData?.title || item.slug;
              const url = contentUrl(item.type, item.slug);
              return (
                <button
                  key={item.id}
                  type="button"
                  className="btn"
                  onClick={() => onSelect({ url, title })}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: "1rem",
                    textAlign: "left",
                    width: "100%",
                  }}
                >
                  <span style={{ fontWeight: 500 }}>{title}</span>
                  <span style={{ color: "var(--color-text-muted)", fontSize: "0.8rem" }}>{url}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
