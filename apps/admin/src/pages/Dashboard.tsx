import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useAuth } from "../context/AuthContext";
import { site } from "../lib/api";

interface Stats {
  content: { pages: number; posts: number; published: number; drafts: number };
  media: number;
  activity: { action: string; entityType: string; createdAt: string; details: Record<string, unknown> }[];
}

function timeAgo(dateStr: string, t: TFunction): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return t("common.justNow");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("common.minutesAgo", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("common.hoursAgo", { count: hours });
  const days = Math.floor(hours / 24);
  return t("common.daysAgo", { count: days });
}

function describeActivity(action: string, details: Record<string, unknown>, t: TFunction): string {
  const name = (details.title || details.name || details.slug || "") as string;

  switch (action) {
    case "content.created":
      return name ? t("dashboard.activity.createdNamed", { name }) : t("dashboard.activity.createdItem");
    case "content.updated":
      return name ? t("dashboard.activity.updatedNamed", { name }) : t("dashboard.activity.updatedItem");
    case "content.deleted":
      return name ? t("dashboard.activity.deletedNamed", { name }) : t("dashboard.activity.deletedItem");
    case "collection.created":
      return name ? t("dashboard.activity.collectionCreatedNamed", { name }) : t("dashboard.activity.collectionCreated");
    case "collection.updated": {
      const changes = details.changes as string[] | undefined;
      const suffix = changes?.length ? ` (${changes.join(", ")})` : "";
      return name
        ? t("dashboard.activity.collectionUpdatedNamed", { name, suffix })
        : t("dashboard.activity.collectionUpdated", { suffix });
    }
    case "collection.deleted":
      return name ? t("dashboard.activity.collectionDeletedNamed", { name }) : t("dashboard.activity.collectionDeleted");
    case "media.uploaded":
      return name ? t("dashboard.activity.uploadedNamed", { name }) : t("dashboard.activity.uploadedItem");
    case "media.deleted":
      return name ? t("dashboard.activity.mediaDeletedNamed", { name }) : t("dashboard.activity.mediaDeleted");
    case "site.updated":
      return t("dashboard.activity.siteUpdated");
    default:
      // Long tail of audit-log action codes from across the app (billing,
      // team, domains, etc.) — not worth a translation key each, so fall
      // back to a title-cased rendering of the raw code.
      return action.replace(".", " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }
}

export function Dashboard() {
  const { t } = useTranslation();
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
        <h2>{t("nav.dashboard")}</h2>
        <p>{t("common.loading")}</p>
      </div>
    );
  }

  return (
    <div className="page">
      <h2>{t("nav.dashboard")}</h2>

      <div className="stat-cards">
        <div className="stat-card">
          <div className="stat-card-value">{stats?.content.pages ?? 0}</div>
          <div className="stat-card-label">{t("dashboard.pages")}</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-value">{stats?.content.posts ?? 0}</div>
          <div className="stat-card-label">{t("dashboard.posts")}</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-value">{stats?.media ?? 0}</div>
          <div className="stat-card-label">{t("dashboard.media")}</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-value">{stats?.content.published ?? 0}</div>
          <div className="stat-card-label">{t("dashboard.published")}</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-value">{stats?.content.drafts ?? 0}</div>
          <div className="stat-card-label">{t("dashboard.drafts")}</div>
        </div>
      </div>

      <div className="quick-actions">
        <Link to="/content/new?type=page" className="btn btn-primary">{t("dashboard.newPage")}</Link>
        <Link to="/content/new?type=post" className="btn">{t("dashboard.newPost")}</Link>
        <Link to="/media" className="btn">{t("dashboard.uploadMedia")}</Link>
        <button className="btn" onClick={() => window.dispatchEvent(new CustomEvent("cadmus:open-ai-drawer"))}>{t("dashboard.aiAssistant")}</button>
      </div>

      <section className="card" style={{ marginTop: "1.5rem" }}>
        <h3>{t("dashboard.recentActivity")}</h3>
        {stats?.activity.length ? (
          <div className="activity-feed">
            {stats.activity.map((item, i) => (
              <div key={i} className="activity-item">
                <span>{describeActivity(item.action, item.details, t)}</span>
                <span className="activity-time">{timeAgo(item.createdAt, t)}</span>
              </div>
            ))}
          </div>
        ) : (
          <p style={{ color: "var(--color-text-muted)", marginTop: "0.5rem" }}>{t("dashboard.noActivity")}</p>
        )}
      </section>
    </div>
  );
}
