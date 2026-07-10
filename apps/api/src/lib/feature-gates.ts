import { eq, and, sum, sql, count } from "drizzle-orm";
import { db, sites, platformConfig, aiUsage, media, content } from "@cadmus/db";

export type FeatureKey =
  | "custom_domain"
  | "team_members"
  | "ai_chat_message"
  | "ai_image_generation"
  | "page_count"
  | "post_count"
  | "storage_upload"
  | "form_email_notification";

export interface GateResult {
  allowed: boolean;
  limit: number | null;
  usage: number | null;
  period: "daily" | "monthly" | "lifetime" | null;
  reason?: string;
}

/**
 * A "comped" (a.k.a. internal / forever-free) site: granted unlimited features
 * with no Stripe billing. This is distinct from the free *tier* (`plan: "free"`,
 * which is limited). A site qualifies if it's on the `comped` plan, or if its
 * billing mode is `free` (no Stripe). Comped sites bypass every feature limit
 * AND the payment-method requirement on custom domains.
 *
 * Note the asymmetry with the feature gate below: the gate keys off `plan` only
 * (any non-"free" plan is unlimited), so a paid site stays unlimited regardless
 * of billing. This helper additionally covers billing-free sites for the
 * billing-side gates (e.g. the custom-domain payment requirement).
 */
export function isCompedSite(site: { plan?: string | null; billing?: string | null }): boolean {
  return site.plan === "comped" || site.billing === "free";
}

const CONFIG_KEY_MAP: Record<Exclude<FeatureKey, "custom_domain">, string> = {
  team_members: "free_team_members",
  ai_chat_message: "free_chat_messages_daily",
  ai_image_generation: "free_images_monthly",
  page_count: "free_max_pages",
  post_count: "free_max_posts",
  storage_upload: "free_storage_mb",
  form_email_notification: "free_form_notifications_monthly",
};

const PERIOD_TYPE_MAP: Record<Exclude<FeatureKey, "custom_domain">, "daily" | "monthly" | "lifetime"> = {
  team_members: "lifetime",
  ai_chat_message: "daily",
  ai_image_generation: "monthly",
  page_count: "lifetime",
  post_count: "lifetime",
  storage_upload: "lifetime",
  form_email_notification: "monthly",
};

// Usage type stored in ai_usage table (only for AI-tracked features)
const USAGE_TYPE_MAP: Partial<Record<FeatureKey, string>> = {
  ai_chat_message: "chat_message",
  ai_image_generation: "image_generation",
  form_email_notification: "form_notification",
};

function getCurrentPeriod(periodType: "daily" | "monthly" | "lifetime"): string {
  const now = new Date();
  if (periodType === "daily") return now.toISOString().slice(0, 10);
  if (periodType === "monthly") return now.toISOString().slice(0, 7);
  return "lifetime";
}

export async function getPlatformConfig(): Promise<Record<string, number>> {
  const rows = await db.select().from(platformConfig);
  const result: Record<string, number> = {};
  for (const row of rows) {
    const v = row.value;
    const num = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
    if (!isNaN(num)) result[row.key] = num;
  }
  return result;
}

export async function checkFeatureGate(
  siteId: string,
  feature: FeatureKey,
  extraContext?: { uploadBytes?: number; currentTeamCount?: number },
): Promise<GateResult> {
  const [site] = await db.select({ plan: sites.plan }).from(sites).where(eq(sites.id, siteId));
  if (!site) return { allowed: false, limit: null, usage: null, period: null, reason: "Site not found" };

  if (site.plan !== "free") return { allowed: true, limit: null, usage: null, period: null };

  if (feature === "custom_domain") {
    return { allowed: false, limit: 0, usage: null, period: null, reason: "Custom domains are not available on the free plan" };
  }

  const configKey = CONFIG_KEY_MAP[feature];
  const periodType = PERIOD_TYPE_MAP[feature];

  const config = await getPlatformConfig();
  const limit = config[configKey] ?? null;
  if (limit === null) return { allowed: true, limit: null, usage: null, period: periodType };

  let usage: number;

  if (feature === "storage_upload") {
    const [row] = await db.select({ used: sum(media.fileSize) }).from(media).where(eq(media.siteId, siteId));
    const usedMb = Number(row?.used ?? 0) / (1024 * 1024);
    const totalMb = usedMb + (extraContext?.uploadBytes ?? 0) / (1024 * 1024);
    return { allowed: totalMb <= limit, limit, usage: usedMb, period: periodType, reason: totalMb > limit ? `Storage limit of ${limit} MB reached` : undefined };
  }

  if (feature === "team_members") {
    usage = extraContext?.currentTeamCount ?? 0;
    return { allowed: usage < limit, limit, usage, period: periodType, reason: usage >= limit ? `Team member limit of ${limit} reached on the free plan` : undefined };
  }

  if (feature === "page_count") {
    const [row] = await db.select({ c: count() }).from(content)
      .where(and(eq(content.siteId, siteId), eq(content.type, "page"), sql`${content.status} != 'archived'`));
    usage = Number(row?.c ?? 0);
    return { allowed: usage < limit, limit, usage, period: periodType, reason: usage >= limit ? `Free sites are limited to ${limit} pages. Upgrade to add more.` : undefined };
  }

  if (feature === "post_count") {
    const [row] = await db.select({ c: count() }).from(content)
      .where(and(eq(content.siteId, siteId), eq(content.type, "post"), sql`${content.status} != 'archived'`));
    usage = Number(row?.c ?? 0);
    return { allowed: usage < limit, limit, usage, period: periodType, reason: usage >= limit ? `Free sites are limited to ${limit} posts. Upgrade to add more.` : undefined };
  }

  // ai_usage table features
  const usageType = USAGE_TYPE_MAP[feature];
  if (!usageType) return { allowed: true, limit: null, usage: null, period: periodType };

  const period = getCurrentPeriod(periodType);
  const [usageRow] = await db.select({ count: aiUsage.count }).from(aiUsage)
    .where(and(eq(aiUsage.siteId, siteId), eq(aiUsage.usageType, usageType), eq(aiUsage.period, period)));
  usage = usageRow?.count ?? 0;

  return { allowed: usage < limit, limit, usage, period: periodType, reason: usage >= limit ? `${feature} limit of ${limit} per ${periodType} reached` : undefined };
}

export async function incrementUsage(siteId: string, usageType: string, period: string): Promise<void> {
  await db
    .insert(aiUsage)
    .values({ siteId, usageType, period, count: 1 })
    .onConflictDoUpdate({
      target: [aiUsage.siteId, aiUsage.usageType, aiUsage.period],
      set: { count: sql`${aiUsage.count} + 1` },
    });
}
