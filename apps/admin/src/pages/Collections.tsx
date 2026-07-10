import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { collections } from "../lib/api";

interface Collection {
  id: string;
  name: string;
  slug: string;
}

export function Collections() {
  const { t } = useTranslation();
  const [items, setItems] = useState<Collection[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editSlug, setEditSlug] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = (await collections.list("category")) as { items: Collection[] };
      setItems(res.items);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const handler = () => load();
    window.addEventListener("cadmus:content-updated", handler);
    return () => window.removeEventListener("cadmus:content-updated", handler);
  }, [load]);

  const generateSlug = (name: string) =>
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;

    setCreating(true);
    setCreateError("");
    try {
      await collections.create({
        type: "category",
        name: newName.trim(),
        slug: generateSlug(newName),
      });
      setNewName("");
      await load();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : t("collections.createFailed"));
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await collections.delete(id);
      setItems((prev) => prev.filter((c) => c.id !== id));
      if (editingId === id) setEditingId(null);
    } catch {
      // silent
    }
  };

  const startEditing = (item: Collection) => {
    setEditingId(item.id);
    setEditName(item.name);
    setEditSlug(item.slug);
  };

  const cancelEditing = () => {
    setEditingId(null);
  };

  const handleSave = async (id: string) => {
    if (!editName.trim() || !editSlug.trim()) return;
    try {
      await collections.update(id, { name: editName.trim(), slug: editSlug.trim() });
      setItems((prev) =>
        prev.map((c) => (c.id === id ? { ...c, name: editName.trim(), slug: editSlug.trim() } : c))
      );
      setEditingId(null);
    } catch {
      // silent
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <h2>{t("collections.title")}</h2>
      </div>

      <form onSubmit={handleCreate} style={{ display: "flex", gap: "0.5rem", marginBottom: "1.5rem" }}>
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder={t("collections.newNamePlaceholder")}
          style={{ flex: 1 }}
        />
        <button type="submit" className="btn btn-primary" disabled={creating || !newName.trim()}>
          {creating ? t("common.adding") : t("common.add")}
        </button>
      </form>
      {createError && (
        <p style={{ color: "var(--color-error, #dc2626)", fontSize: "0.875rem", marginTop: "-1rem", marginBottom: "1rem" }}>
          {createError}
        </p>
      )}

      {loading ? (
        <p>{t("common.loading")}</p>
      ) : items.length === 0 ? (
        <p style={{ color: "var(--color-text-secondary)" }}>
          {t("collections.empty")}
        </p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", padding: "0.5rem", borderBottom: "1px solid var(--color-border)" }}>{t("collections.table.name")}</th>
              <th style={{ textAlign: "left", padding: "0.5rem", borderBottom: "1px solid var(--color-border)" }}>{t("collections.table.slug")}</th>
              <th style={{ width: "160px", padding: "0.5rem", borderBottom: "1px solid var(--color-border)" }} />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                {editingId === item.id ? (
                  <>
                    <td style={{ padding: "0.5rem", borderBottom: "1px solid var(--color-border)" }}>
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        style={{ width: "100%" }}
                      />
                    </td>
                    <td style={{ padding: "0.5rem", borderBottom: "1px solid var(--color-border)" }}>
                      <input
                        type="text"
                        value={editSlug}
                        onChange={(e) => setEditSlug(e.target.value)}
                        style={{ width: "100%" }}
                      />
                    </td>
                    <td style={{ padding: "0.5rem", borderBottom: "1px solid var(--color-border)", textAlign: "right" }}>
                      <div style={{ display: "flex", gap: "0.25rem", justifyContent: "flex-end" }}>
                        <button
                          type="button"
                          className="btn btn-primary"
                          style={{ fontSize: "0.8rem", padding: "0.25rem 0.5rem" }}
                          onClick={() => handleSave(item.id)}
                        >
                          {t("common.save")}
                        </button>
                        <button
                          type="button"
                          className="btn"
                          style={{ fontSize: "0.8rem", padding: "0.25rem 0.5rem" }}
                          onClick={cancelEditing}
                        >
                          {t("common.cancel")}
                        </button>
                      </div>
                    </td>
                  </>
                ) : (
                  <>
                    <td style={{ padding: "0.5rem", borderBottom: "1px solid var(--color-border)" }}>{item.name}</td>
                    <td style={{ padding: "0.5rem", borderBottom: "1px solid var(--color-border)", color: "var(--color-text-secondary)" }}>
                      {item.slug}
                    </td>
                    <td style={{ padding: "0.5rem", borderBottom: "1px solid var(--color-border)", textAlign: "right" }}>
                      <div style={{ display: "flex", gap: "0.25rem", justifyContent: "flex-end" }}>
                        <button
                          type="button"
                          className="btn"
                          style={{ fontSize: "0.8rem", padding: "0.25rem 0.5rem" }}
                          onClick={() => startEditing(item)}
                        >
                          {t("common.edit")}
                        </button>
                        <button
                          type="button"
                          className="btn"
                          style={{ fontSize: "0.8rem", padding: "0.25rem 0.5rem" }}
                          onClick={() => handleDelete(item.id)}
                        >
                          {t("common.delete")}
                        </button>
                      </div>
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
