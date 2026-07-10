import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { site } from "../lib/api";

interface Stats {
  content: { pages: number; posts: number; published: number; drafts: number };
  media: number;
  activity: { action: string; entityType: string; createdAt: string; details: Record<string, unknown> }[];
}

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function describeActivity(action: string, details: Record<string, unknown>): string {
  const name = (details.title || details.name || details.slug || "") as string;
  const quoted = name ? ` "${name}"` : "";

  switch (action) {
    case "content.created":
      return `Created${quoted || " a new content item"}`;
    case "content.updated":
      return `Updated${quoted || " a content item"}`;
    case "content.deleted":
      return `Deleted${quoted || " a content item"}`;
    case "collection.created":
      return `Created collection${quoted}`;
    case "collection.updated": {
      const changes = details.changes as string[] | undefined;
      const suffix = changes?.length ? ` (${changes.join(", ")})` : "";
      return `Updated collection${quoted}${suffix}`;
    }
    case "collection.deleted":
      return `Deleted collection${quoted}`;
    case "media.uploaded":
      return `Uploaded${quoted || " a file"}`;
    case "media.deleted":
      return `Deleted media${quoted}`;
    case "site.updated":
      return "Updated site settings";
    default:
      return action.replace(".", " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }
}

export function Dashboard() {
  const { user } = useAuth();
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    site
      .stats(user.siteId)
      .then(setStats)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [user]);

  if (loading) {
    return (
      <div className="page">
        <h2>Dashboard</h2>
        <p>Loading...</p>
      </div>
    );
  }

  return (
    <div className="page">
      <h2>Dashboard</h2>

      <div className="stat-cards">
        <div className="stat-card">
          <div className="stat-card-value">{stats?.content.pages ?? 0}</div>
          <div className="stat-card-label">Pages</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-value">{stats?.content.posts ?? 0}</div>
          <div className="stat-card-label">Posts</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-value">{stats?.media ?? 0}</div>
          <div className="stat-card-label">Media</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-value">{stats?.content.published ?? 0}</div>
          <div className="stat-card-label">Published</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-value">{stats?.content.drafts ?? 0}</div>
          <div className="stat-card-label">Drafts</div>
        </div>
      </div>

      <div className="quick-actions">
        <Link to="/content/new?type=page" className="btn btn-primary">New Page</Link>
        <Link to="/content/new?type=post" className="btn">New Post</Link>
        <Link to="/media" className="btn">Upload Media</Link>
        <button className="btn" onClick={() => window.dispatchEvent(new CustomEvent("cadmus:open-ai-drawer"))}>AI Assistant</button>
      </div>

      <section className="card" style={{ marginTop: "1.5rem" }}>
        <h3>Recent Activity</h3>
        {stats?.activity.length ? (
          <div className="activity-feed">
            {stats.activity.map((item, i) => (
              <div key={i} className="activity-item">
                <span>{describeActivity(item.action, item.details)}</span>
                <span className="activity-time">{timeAgo(item.createdAt)}</span>
              </div>
            ))}
          </div>
        ) : (
          <p style={{ color: "var(--color-text-muted)", marginTop: "0.5rem" }}>No activity yet.</p>
        )}
      </section>
    </div>
  );
}
