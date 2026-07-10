import { useState, useEffect, useRef } from "react";
import { mediaReview, type MediaReviewItem } from "../lib/api";

function VideoPlayer({ itemId }: { itemId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef(false);

  const load = async () => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    setLoading(true);
    try {
      const res = await mediaReview.streamUrl(itemId);
      setUrl(res.url);
    } catch {
      setError("Failed to load video");
      loadedRef.current = false;
    } finally {
      setLoading(false);
    }
  };

  if (!url && !loading && !error) {
    return (
      <button className="btn btn-sm" style={{ marginTop: "0.5rem" }} onClick={load}>
        Load video to review
      </button>
    );
  }
  if (loading) return <p style={{ fontSize: "0.8rem", color: "var(--color-text-muted)", marginTop: "0.5rem" }}>Loading video...</p>;
  if (error) return <p style={{ fontSize: "0.8rem", color: "var(--color-danger, #c33)", marginTop: "0.5rem" }}>{error}</p>;
  return (
    <video
      src={url!}
      controls
      style={{ width: "100%", maxHeight: "320px", borderRadius: "6px", background: "#000", display: "block", marginTop: "0.75rem" }}
    />
  );
}

// Opens a non-previewable file (e.g. PDF) in a new tab via the streaming
// proxy. Used for items that have no inline preview — notably large PDFs
// routed straight to manual review with no thumbnail.
function FileViewLink({ itemId }: { itemId: string }) {
  const [loading, setLoading] = useState(false);
  const open = async () => {
    setLoading(true);
    try {
      const res = await mediaReview.streamUrl(itemId);
      if (res.url) window.open(res.url, "_blank", "noopener");
    } catch {
      /* ignore — button just no-ops on failure */
    } finally {
      setLoading(false);
    }
  };
  return (
    <button className="btn btn-sm" style={{ marginTop: "0.25rem" }} disabled={loading} onClick={open}>
      {loading ? "Opening…" : "View file"}
    </button>
  );
}

export function MediaReview() {
  const [reviewItems, setReviewItems] = useState<MediaReviewItem[]>([]);
  const [reviewTotal, setReviewTotal] = useState(0);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewStatusFilter, setReviewStatusFilter] = useState("review");
  const [reviewActing, setReviewActing] = useState<string | null>(null);
  const [blockReason, setBlockReason] = useState<Record<string, string>>({});
  const [blockingId, setBlockingId] = useState<string | null>(null);

  useEffect(() => {
    setReviewLoading(true);
    mediaReview.list(reviewStatusFilter)
      .then((res) => { setReviewItems(res.items); setReviewTotal(res.total); })
      .catch(() => {})
      .finally(() => setReviewLoading(false));
  }, [reviewStatusFilter]);

  const handleApprove = async (id: string) => {
    setReviewActing(id);
    try {
      await mediaReview.approve(id);
      setReviewItems((prev) => prev.filter((item) => item.id !== id));
      setReviewTotal((t) => t - 1);
    } catch { /* ignore */ } finally { setReviewActing(null); }
  };

  const handleBlock = async (id: string, reason?: string) => {
    setReviewActing(id);
    try {
      await mediaReview.block(id, reason);
      setReviewItems((prev) => prev.map((item) =>
        item.id === id ? { ...item, moderationStatus: "blocked", moderationReason: reason ?? null, moderationSource: "manual" } : item
      ));
      setBlockingId(null);
      setBlockReason((prev) => { const n = { ...prev }; delete n[id]; return n; });
    } catch { /* ignore */ } finally { setReviewActing(null); }
  };

  const handleSetStatus = async (id: string, status: string, reason?: string) => {
    setReviewActing(id);
    try {
      await mediaReview.setStatus(id, status, reason);
      if (status === reviewStatusFilter) {
        setReviewItems((prev) => prev.map((item) =>
          item.id === id ? { ...item, moderationStatus: status, moderationReason: reason ?? null } : item
        ));
      } else {
        setReviewItems((prev) => prev.filter((item) => item.id !== id));
        setReviewTotal((t) => t - 1);
      }
    } catch { /* ignore */ } finally { setReviewActing(null); }
  };

  const handleDeleteItem = async (id: string) => {
    setReviewActing(id);
    try {
      await mediaReview.deleteItem(id);
      setReviewItems((prev) => prev.filter((item) => item.id !== id));
      setReviewTotal((t) => t - 1);
    } catch { /* ignore */ } finally { setReviewActing(null); }
  };

  return (
    <div className="page">
      <h2>Media Review</h2>

      <div style={{ marginTop: "1.5rem" }}>
        <div style={{ display: "flex", gap: "0.75rem", marginBottom: "1rem", alignItems: "center" }}>
          <select
            value={reviewStatusFilter}
            onChange={(e) => setReviewStatusFilter(e.target.value)}
            style={{ padding: "0.4rem 0.75rem", borderRadius: "6px", border: "1px solid var(--color-border)" }}
          >
            <option value="review">Needs Review</option>
            <option value="pending">Pending Scan</option>
            <option value="blocked">Blocked</option>
            <option value="approved">Approved</option>
          </select>
          <span style={{ marginLeft: "auto", color: "var(--color-text-muted)", fontSize: "0.875rem" }}>
            {reviewTotal} items
          </span>
        </div>
        {reviewLoading ? (
          <p style={{ color: "var(--color-text-muted)" }}>Loading…</p>
        ) : reviewItems.length === 0 ? (
          <div className="card" style={{ padding: "2rem", textAlign: "center", color: "var(--color-text-muted)" }}>
            No items to review.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            {reviewItems.map((item) => (
              <div key={item.id} className="card" style={{ padding: "1rem" }}>
                <div style={{ display: "flex", gap: "1rem", alignItems: "flex-start" }}>
                  {item.mimeType?.startsWith("image/") && item.moderationStatus !== "pending" ? (
                    <img src={item.storageUrl} alt={item.filename} style={{ width: 80, height: 80, objectFit: "cover", borderRadius: 4, flexShrink: 0 }} />
                  ) : (
                    <div style={{ width: 80, height: 80, background: "var(--color-surface-2, #f5f5f5)", borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: "0.75rem", color: "var(--color-text-muted)" }}>
                      {item.moderationStatus === "pending" ? "Processing…" : item.mimeType?.split("/")[0]?.toUpperCase() ?? "FILE"}
                    </div>
                  )}
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, marginBottom: "0.25rem" }}>{item.filename}</div>
                    <div style={{ fontSize: "0.8rem", color: "var(--color-text-muted)", marginBottom: "0.5rem" }}>
                      {item.siteName} · {new Date(item.createdAt).toLocaleString()}
                    </div>
                    {!item.mimeType?.startsWith("image/") && !item.mimeType?.startsWith("video/") && item.moderationStatus !== "pending" && (
                      <FileViewLink itemId={item.id} />
                    )}
                    {item.moderationScores && Object.keys(item.moderationScores).length > 0 && (
                      <div style={{ fontSize: "0.75rem", color: "var(--color-text-muted)", marginBottom: "0.5rem" }}>
                        {Object.entries(item.moderationScores).map(([k, v]) => (
                          <span key={k} style={{ marginRight: "0.75rem" }}>{k}: <strong>{v}</strong></span>
                        ))}
                      </div>
                    )}
                    {(item.moderationStatus === "review" || item.moderationStatus === "pending") && (
                      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                        <div style={{ display: "flex", gap: "0.5rem" }}>
                          <button
                            className="btn btn-primary btn-sm"
                            disabled={reviewActing === item.id}
                            onClick={() => handleApprove(item.id)}
                          >
                            Approve
                          </button>
                          {blockingId === item.id ? (
                            <>
                              <input
                                type="text"
                                placeholder="Reason (optional)"
                                value={blockReason[item.id] || ""}
                                onChange={(e) => setBlockReason((prev) => ({ ...prev, [item.id]: e.target.value }))}
                                style={{ fontSize: "0.8rem", padding: "0.25rem 0.5rem", borderRadius: "4px", border: "1px solid var(--color-border)", flex: 1 }}
                              />
                              <button
                                className="btn btn-sm"
                                style={{ color: "var(--color-danger, #c33)", borderColor: "var(--color-danger, #c33)" }}
                                disabled={reviewActing === item.id}
                                onClick={() => handleBlock(item.id, blockReason[item.id] || undefined)}
                              >
                                Confirm Block
                              </button>
                              <button
                                className="btn btn-sm"
                                disabled={reviewActing === item.id}
                                onClick={() => setBlockingId(null)}
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              className="btn btn-sm"
                              style={{ color: "var(--color-danger, #c33)", borderColor: "var(--color-danger, #c33)" }}
                              disabled={reviewActing === item.id}
                              onClick={() => setBlockingId(item.id)}
                            >
                              Block
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                    {item.moderationStatus === "blocked" && (
                      <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                        {item.moderationReason && (
                          <div style={{ fontSize: "0.75rem", color: "var(--color-text-muted)" }}>
                            Reason: {item.moderationReason}
                          </div>
                        )}
                        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                          {item.moderationSource === "auto" ? (
                            <span style={{ fontSize: "0.75rem", color: "var(--color-text-muted)" }}>
                              Auto-blocked — original file deleted
                            </span>
                          ) : (
                            <button
                              className="btn btn-sm"
                              disabled={reviewActing === item.id}
                              onClick={() => handleSetStatus(item.id, "review")}
                            >
                              Send to Review
                            </button>
                          )}
                          <button
                            className="btn btn-sm"
                            style={{ color: "var(--color-danger, #c33)", borderColor: "var(--color-danger, #c33)" }}
                            disabled={reviewActing === item.id}
                            onClick={() => {
                              if (window.confirm("Permanently delete this item?")) {
                                handleDeleteItem(item.id);
                              }
                            }}
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    )}
                    {item.moderationStatus === "approved" && (
                      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                        <div style={{ display: "flex", gap: "0.5rem" }}>
                          {blockingId === item.id ? (
                            <>
                              <input
                                type="text"
                                placeholder="Reason (optional)"
                                value={blockReason[item.id] || ""}
                                onChange={(e) => setBlockReason((prev) => ({ ...prev, [item.id]: e.target.value }))}
                                style={{ fontSize: "0.8rem", padding: "0.25rem 0.5rem", borderRadius: "4px", border: "1px solid var(--color-border)", flex: 1 }}
                              />
                              <button
                                className="btn btn-sm"
                                style={{ color: "var(--color-danger, #c33)", borderColor: "var(--color-danger, #c33)" }}
                                disabled={reviewActing === item.id}
                                onClick={() => handleBlock(item.id, blockReason[item.id] || undefined)}
                              >
                                Confirm Block
                              </button>
                              <button
                                className="btn btn-sm"
                                disabled={reviewActing === item.id}
                                onClick={() => setBlockingId(null)}
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              className="btn btn-sm"
                              style={{ color: "var(--color-danger, #c33)", borderColor: "var(--color-danger, #c33)" }}
                              disabled={reviewActing === item.id}
                              onClick={() => setBlockingId(item.id)}
                            >
                              Block
                            </button>
                          )}
                          <button
                            className="btn btn-sm"
                            disabled={reviewActing === item.id}
                            onClick={() => handleSetStatus(item.id, "review")}
                          >
                            Send to Review
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
                {item.mimeType?.startsWith("video/") && item.moderationStatus !== "pending" && (
                  <VideoPlayer itemId={item.id} />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
