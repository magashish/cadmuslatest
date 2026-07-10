import { useState, useEffect, useCallback } from "react";
import { collections } from "../lib/api";

interface Collection {
  id: string;
  name: string;
}

interface Props {
  contentId: string;
}

export function CollectionPicker({ contentId }: Props) {
  const [categories, setCategories] = useState<Collection[]>([]);
  const [assignedIds, setAssignedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [catRes, assignedRes] = await Promise.all([
        collections.list("category") as Promise<{ items: Collection[] }>,
        collections.forContent(contentId) as Promise<{ items: Collection[] }>,
      ]);
      setCategories(catRes.items);
      setAssignedIds(new Set(assignedRes.items.map((c) => c.id)));
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [contentId]);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = async (collectionId: string) => {
    const isAssigned = assignedIds.has(collectionId);
    try {
      if (isAssigned) {
        await collections.removeContent(collectionId, contentId);
        setAssignedIds((prev) => {
          const next = new Set(prev);
          next.delete(collectionId);
          return next;
        });
      } else {
        await collections.addContent(collectionId, contentId);
        setAssignedIds((prev) => new Set(prev).add(collectionId));
      }
    } catch {
      // silent
    }
  };

  if (loading) return null;
  if (categories.length === 0) return null;

  return (
    <div className="editor-meta-row">
      <div className="form-group">
        <label>Collections</label>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
          {categories.map((item) => (
            <label key={item.id} style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontWeight: "normal", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={assignedIds.has(item.id)}
                onChange={() => toggle(item.id)}
              />
              {item.name}
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
