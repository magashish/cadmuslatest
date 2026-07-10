import { Hono } from "hono";
import type { SiteEnv } from "../middleware/tenant.js";
import type { AuthUser } from "@cadmus/shared";
import { checkFeatureGate, type FeatureKey, type GateResult } from "../lib/feature-gates.js";
import { db, siteMembers } from "@cadmus/db";
import { eq, and } from "drizzle-orm";

export const featureGatesRoutes = new Hono<SiteEnv & { Variables: { user: AuthUser } }>();

const ALL_FEATURES: FeatureKey[] = [
  "custom_domain",
  "team_members",
  "ai_chat_message",
  "ai_image_generation",
  "page_count",
  "post_count",
  "storage_upload",
  "form_email_notification",
];

// GET /api/feature-gates — return all gate statuses for the current site
featureGatesRoutes.get("/", async (c) => {
  const siteId = c.get("site").siteId;

  // Get current active team count for team_members gate
  const members = await db
    .select({ id: siteMembers.id })
    .from(siteMembers)
    .where(and(eq(siteMembers.siteId, siteId), eq(siteMembers.status, "active")));
  const currentTeamCount = members.length;

  const results = await Promise.all(
    ALL_FEATURES.map(async (feature) => {
      const result = await checkFeatureGate(siteId, feature, {
        currentTeamCount: feature === "team_members" ? currentTeamCount : undefined,
      });
      return [feature, result] as [FeatureKey, GateResult];
    }),
  );

  const gates = Object.fromEntries(results) as Record<FeatureKey, GateResult>;
  return c.json(gates);
});
