import { Hono } from "hono";
import type { AuthUser } from "@cadmus/shared";

const SENTRY_ORG = "frobro-web-technologies";
const SENTRY_API_BASE = "https://us.sentry.io/api/0";
const SENTRY_PROJECTS = [
  "cadmus-api",
  "cadmus-admin",
  "cadmus-web",
  "cadmus-scanner",
  "cadmus-dashboard",
];

interface SentryIssue {
  id: string;
  title: string;
  project: string;
  lastSeen: string;
  count: number;
  level: string;
  permalink: string;
}

const SENTRY_ENVIRONMENT = process.env.NODE_ENV === "production" ? "production" : "development";

interface CacheEntry {
  data: SentryIssue[];
  fetchedAt: Date;
}

let cache: CacheEntry | null = null;
const CACHE_TTL_SECONDS = 300;

export const sentryAlertsRoutes = new Hono<{ Variables: { user: AuthUser } }>();

sentryAlertsRoutes.get("/issues", async (c) => {
  const authToken = process.env.SENTRY_AUTH_TOKEN;
  if (!authToken) {
    return c.json({ error: "Sentry integration not configured" }, 503);
  }

  const now = new Date();

  // Return cached response if still fresh
  if (cache && (now.getTime() - cache.fetchedAt.getTime()) / 1000 < CACHE_TTL_SECONDS) {
    const cachedAt = cache.fetchedAt.toISOString();
    const nextRefreshAt = new Date(cache.fetchedAt.getTime() + CACHE_TTL_SECONDS * 1000).toISOString();
    return c.json({ issues: cache.data, cachedAt, nextRefreshAt, environment: SENTRY_ENVIRONMENT });
  }

  // Fetch from all projects in parallel
  const results = await Promise.all(
    SENTRY_PROJECTS.map(async (project) => {
      const url = `${SENTRY_API_BASE}/projects/${SENTRY_ORG}/${project}/issues/?query=is:unresolved&environment=${SENTRY_ENVIRONMENT}&limit=25&statsPeriod=24h`;
      try {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (res.status === 404) {
          // Project doesn't exist yet in Sentry — skip gracefully
          return [];
        }
        if (!res.ok) {
          console.error(`Sentry API error for ${project}: HTTP ${res.status}`);
          return [];
        }
        const raw = (await res.json()) as Array<{
          id: string;
          title: string;
          lastSeen: string;
          count: string;
          level: string;
        }>;
        return raw.map((issue): SentryIssue => ({
          id: issue.id,
          title: issue.title,
          project,
          lastSeen: issue.lastSeen,
          count: Number(issue.count),
          level: issue.level,
          permalink: `https://${SENTRY_ORG}.sentry.io/issues/${issue.id}/`,
        }));
      } catch (err) {
        console.error(`Failed to fetch Sentry issues for ${project}:`, err);
        return [];
      }
    }),
  );

  // Flatten, sort by lastSeen descending, take top 30
  const allIssues = results
    .flat()
    .sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime())
    .slice(0, 30);

  const fetchedAt = new Date();
  cache = { data: allIssues, fetchedAt };

  const cachedAt = fetchedAt.toISOString();
  const nextRefreshAt = new Date(fetchedAt.getTime() + CACHE_TTL_SECONDS * 1000).toISOString();

  return c.json({ issues: allIssues, cachedAt, nextRefreshAt, environment: SENTRY_ENVIRONMENT });
});
