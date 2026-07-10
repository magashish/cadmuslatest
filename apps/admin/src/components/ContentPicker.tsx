import { useState, useEffect, useCallback } from "react";
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
          <h3>Select a page or post</h3>
        </div>

        <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.75rem" }}>
          {(["page", "post"] as const).map((t) => (
            <button
              key={t}
              type="button"
              className="btn"
              onClick={() => setType(t)}
              style={{
                fontWeight: type === t ? 600 : 400,
                borderBottom: type === t ? "2px solid var(--color-primary)" : undefined,
              }}
            >
              {t === "page" ? "Pages" : "Posts"}
            </button>
          ))}
        </div>

        {loading ? (
          <p>Loading...</p>
        ) : items.length === 0 ? (
          <p style={{ color: "var(--color-text-muted)" }}>
            No published {type === "page" ? "pages" : "posts"} yet.
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
