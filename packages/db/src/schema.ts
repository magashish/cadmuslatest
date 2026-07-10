import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  bigint,
  varchar,
  boolean,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/pg-core";

// ── Sites ───────────────────────────────────────────────────────────────────

export const sites = pgTable(
  "sites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 255 }).notNull(),
    subdomain: varchar("subdomain", { length: 63 }).notNull(), // e.g. "site-abc123" → site-abc123.cadmus.digital
    domain: varchar("domain", { length: 255 }), // custom domain, null until configured
    domainStatus: varchar("domain_status", { length: 20 }), // pending, ssl_pending, active, failed
    domainMeta: jsonb("domain_meta"), // { cfHostnameId: string, ... }
    status: varchar("status", { length: 20 }).notNull().default("onboarding"), // onboarding, active, suspended, archived, free
    plan: varchar("plan", { length: 20 }).notNull().default("free"), // free, monthly, annual
    planEndsAt: timestamp("plan_ends_at"), // set when paid user cancels; features stay active until this date
    promoEndsAt: timestamp("promo_ends_at"), // set when a promo trial is applied; features active until this date
    promoCode: varchar("promo_code", { length: 100 }), // which promo code was redeemed
    previousSubdomain: varchar("previous_subdomain", { length: 100 }), // old subdomain after a change
    previousSubdomainExpiresAt: timestamp("previous_subdomain_expires_at"), // 48hr redirect expiry for paid sites
    billing: varchar("billing", { length: 10 }).notNull().default("standard"), // "standard" | "free" — free skips Stripe entirely (internal sites)
    brief: jsonb("brief"),
    settings: jsonb("settings").default({}),
    trialEndsAt: timestamp("trial_ends_at"), // denormalized from subscriptions for fast checks
    suspendedAt: timestamp("suspended_at"), // set when status transitions to suspended
    suspensionReason: text("suspension_reason"), // human-readable reason, shown to owner
    suspensionSource: varchar("suspension_source", { length: 20 }), // "admin" | "billing" — gates auto-restore
    archivedAt: timestamp("archived_at"), // set when status transitions to archived
    archiveReason: text("archive_reason"),
    hardDeleteAt: timestamp("hard_delete_at"), // archivedAt + grace period; null outside archive
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("sites_subdomain_idx").on(table.subdomain),
    uniqueIndex("sites_domain_idx").on(table.domain),
  ]
);

// ── Users ───────────────────────────────────────────────────────────────────

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  siteId: uuid("site_id").references(() => sites.id), // default/current site (nullable — authoritative relationship is site_members)
  email: varchar("email", { length: 255 }).notNull().unique(),
  firstName: varchar("first_name", { length: 100 }),
  lastName: varchar("last_name", { length: 100 }),
  role: varchar("role", { length: 50 }).notNull().default("editor"), // legacy per-site role, use site_members.role instead
  globalRole: varchar("global_role", { length: 20 }).notNull().default("user"), // "user", "partner", "cadmus_admin"
  passwordHash: text("password_hash"),
  resetToken: varchar("reset_token", { length: 255 }),
  resetTokenExpiry: timestamp("reset_token_expiry"),
  // Team invite tokens, stored hashed (sha256 hex) and separate from password
  // reset so an invite link can't double as a reset link, and a DB leak doesn't
  // expose usable invite URLs.
  inviteTokenHash: varchar("invite_token_hash", { length: 64 }),
  inviteTokenExpiry: timestamp("invite_token_expiry"),
  // Bumped to invalidate all existing JWTs for this user (password change/reset,
  // forced logout). The signed token carries the version it was minted at; auth
  // rejects tokens whose version is below the current one.
  tokenVersion: integer("token_version").notNull().default(0),
  referralCode: varchar("referral_code", { length: 50 }).unique(), // auto-generated, for referral tracking
  preferences: jsonb("preferences").default({}),
  emailVerifiedAt: timestamp("email_verified_at"),
  emailVerificationToken: varchar("email_verification_token", { length: 64 }),
  emailVerificationTokenExpiresAt: timestamp("email_verification_token_expires_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Site Members (user↔site junction with roles) ────────────────────────────

export const siteMembers = pgTable(
  "site_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteId: uuid("site_id").references(() => sites.id).notNull(),
    userId: uuid("user_id").references(() => users.id).notNull(),
    role: varchar("role", { length: 50 }).notNull().default("editor"), // "owner", "admin", "editor", "viewer"
    invitedBy: uuid("invited_by").references(() => users.id),
    invitedAt: timestamp("invited_at").defaultNow().notNull(),
    joinedAt: timestamp("joined_at"), // null until invite accepted
    status: varchar("status", { length: 20 }).notNull().default("active"), // "active", "invited", "removed"
  },
  (table) => [
    uniqueIndex("site_members_unique_idx").on(table.siteId, table.userId),
    index("site_members_site_idx").on(table.siteId),
    index("site_members_user_idx").on(table.userId),
  ]
);

// ── Subscriptions (Stripe billing) ───────────────────────────────────────────

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteId: uuid("site_id").references(() => sites.id).notNull(),
    stripeCustomerId: varchar("stripe_customer_id", { length: 255 }).notNull(),
    stripeSubscriptionId: varchar("stripe_subscription_id", { length: 255 }),
    stripePriceId: varchar("stripe_price_id", { length: 255 }),
    status: varchar("status", { length: 30 }).notNull().default("trialing"), // trialing, active, past_due, canceled, unpaid
    trialStartedAt: timestamp("trial_started_at"),
    trialEndsAt: timestamp("trial_ends_at"),
    currentPeriodStart: timestamp("current_period_start"),
    currentPeriodEnd: timestamp("current_period_end"),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    hasEverPaid: boolean("has_ever_paid").notNull().default(false), // true after first successful invoice — distinguishes trial-end from retries-exhausted
    billingUserId: uuid("billing_user_id").references(() => users.id), // who pays
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("subscriptions_site_idx").on(table.siteId),
    index("subscriptions_stripe_customer_idx").on(table.stripeCustomerId),
  ]
);

export const paymentMethods = pgTable("payment_methods", {
  id: uuid("id").primaryKey().defaultRandom(),
  subscriptionId: uuid("subscription_id").references(() => subscriptions.id).notNull(),
  stripePaymentMethodId: varchar("stripe_payment_method_id", { length: 255 }).notNull(),
  type: varchar("type", { length: 50 }), // card, bank
  last4: varchar("last4", { length: 4 }),
  brand: varchar("brand", { length: 50 }),
  expiryMonth: integer("expiry_month"),
  expiryYear: integer("expiry_year"),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Partners ────────────────────────────────────────────────────────────────

export const partners = pgTable(
  "partners",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id).notNull(), // the partner's user account
    name: varchar("name", { length: 255 }).notNull(), // company/brand name
    code: varchar("code", { length: 50 }).notNull(), // signup code e.g. "WEBDEV2026"
    stripeCustomerId: varchar("stripe_customer_id", { length: 255 }), // partner's own Stripe customer
    commissionRate: varchar("commission_rate", { length: 10 }), // future: percentage for referral
    commissionsOnAddons: boolean("commissions_on_addons").notNull().default(false), // commission covers add-on revenue too (default: plan only)
    // Agency partners get a client-invite link: signups through it auto-add the
    // partner as a site admin and create a pending partner_sites (billing) link.
    isAgency: boolean("is_agency").notNull().default(false),
    status: varchar("status", { length: 20 }).notNull().default("active"), // active, suspended
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("partners_code_idx").on(table.code),
    index("partners_user_idx").on(table.userId),
  ]
);

export const partnerSites = pgTable(
  "partner_sites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    partnerId: uuid("partner_id").references(() => partners.id).notNull(),
    siteId: uuid("site_id").references(() => sites.id).notNull(),
    billingActive: boolean("billing_active").notNull().default(true), // partner currently paying
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("partner_sites_unique_idx").on(table.partnerId, table.siteId),
    index("partner_sites_site_idx").on(table.siteId),
  ]
);

// ── Referrals ───────────────────────────────────────────────────────────────

export const referrals = pgTable(
  "referrals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    referrerUserId: uuid("referrer_user_id").references(() => users.id).notNull(), // who referred
    referredSiteId: uuid("referred_site_id").references(() => sites.id).notNull(), // the site created via referral
    referralCode: varchar("referral_code", { length: 50 }).notNull(), // the code used
    status: varchar("status", { length: 20 }).notNull().default("pending"), // pending, qualified, rewarded
    qualifiedAt: timestamp("qualified_at"), // when referred site became paying
    rewardedAt: timestamp("rewarded_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("referrals_referrer_idx").on(table.referrerUserId),
    index("referrals_site_idx").on(table.referredSiteId),
    index("referrals_code_idx").on(table.referralCode),
  ]
);

// ── Content ─────────────────────────────────────────────────────────────────

export const content = pgTable(
  "content",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteId: uuid("site_id").references(() => sites.id).notNull(),
    type: varchar("type", { length: 50 }).notNull(), // page, post, product
    slug: varchar("slug", { length: 500 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("draft"),
    schemaData: jsonb("schema_data").default({}),
    createdBy: uuid("created_by").references(() => users.id),
    publishedAt: timestamp("published_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("content_site_type_idx").on(table.siteId, table.type),
    index("content_slug_idx").on(table.siteId, table.slug),
  ]
);

// ── Content Blocks ──────────────────────────────────────────────────────────

export const contentBlocks = pgTable(
  "content_blocks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contentId: uuid("content_id").references(() => content.id, { onDelete: "cascade" }).notNull(),
    position: integer("position").notNull(),
    blockType: varchar("block_type", { length: 50 }).notNull(),
    data: jsonb("data").default({}),
  },
  (table) => [
    index("blocks_content_idx").on(table.contentId),
  ]
);

// ── Content Versions ────────────────────────────────────────────────────────

export const contentVersions = pgTable("content_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  contentId: uuid("content_id").references(() => content.id, { onDelete: "cascade" }).notNull(),
  version: integer("version").notNull(),
  schemaData: jsonb("schema_data"),
  blocksSnapshot: jsonb("blocks_snapshot"),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Collections ─────────────────────────────────────────────────────────────

export const collections = pgTable("collections", {
  id: uuid("id").primaryKey().defaultRandom(),
  siteId: uuid("site_id").references(() => sites.id).notNull(),
  type: varchar("type", { length: 50 }).notNull(), // category, tag, series, etc.
  name: varchar("name", { length: 255 }).notNull(),
  slug: varchar("slug", { length: 500 }).notNull(),
  parentId: uuid("parent_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [uniqueIndex("collections_site_slug_idx").on(t.siteId, t.slug)]);

export const contentCollections = pgTable("content_collections", {
  contentId: uuid("content_id").references(() => content.id, { onDelete: "cascade" }).notNull(),
  collectionId: uuid("collection_id").references(() => collections.id, { onDelete: "cascade" }).notNull(),
});

// ── Media ───────────────────────────────────────────────────────────────────

export const media = pgTable("media", {
  id: uuid("id").primaryKey().defaultRandom(),
  siteId: uuid("site_id").references(() => sites.id).notNull(),
  filename: varchar("filename", { length: 500 }).notNull(),
  storageUrl: text("storage_url").notNull(),
  mimeType: varchar("mime_type", { length: 100 }),
  fileSize: bigint("file_size", { mode: "number" }).default(0).notNull(),
  variants: jsonb("variants").default({}),
  aiAltText: text("ai_alt_text"),
  thumbnailUrl: text("thumbnail_url"),
  aiTags: jsonb("ai_tags").default([]),
  moderationStatus: varchar("moderation_status", { length: 20 }).default("approved").notNull(),
  moderationScores: jsonb("moderation_scores").default({}),
  moderationReason: text("moderation_reason"),
  moderationSource: varchar("moderation_source", { length: 20 }),
  blockedAt: timestamp("blocked_at"),
  stagingPath: text("staging_path"),
  uploadedBy: uuid("uploaded_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
},
(table) => [index("media_moderation_status_idx").on(table.moderationStatus)]);

export const contentMedia = pgTable("content_media", {
  contentId: uuid("content_id").references(() => content.id, { onDelete: "cascade" }).notNull(),
  mediaId: uuid("media_id").references(() => media.id).notNull(),
  context: varchar("context", { length: 100 }),
});

// ── Navigation ──────────────────────────────────────────────────────────────

export const navigation = pgTable("navigation", {
  id: uuid("id").primaryKey().defaultRandom(),
  siteId: uuid("site_id").references(() => sites.id).notNull(),
  location: varchar("location", { length: 100 }).notNull(), // header, footer, sidebar
  items: jsonb("items").default([]),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ── Scheduled Tasks ─────────────────────────────────────────────────────────

export const scheduledTasks = pgTable(
  "scheduled_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteId: uuid("site_id").references(() => sites.id).notNull(),
    taskType: varchar("task_type", { length: 50 }).notNull(), // publish_content, ai_reminder, ai_generate, seo_audit, addon_sync
    payload: jsonb("payload").default({}),
    runAt: timestamp("run_at").notNull(),
    recurrence: varchar("recurrence", { length: 100 }), // null = one-time, or cron expression
    status: varchar("status", { length: 20 }).notNull().default("pending"), // pending, running, completed, failed, cancelled
    lastRunAt: timestamp("last_run_at"),
    nextRunAt: timestamp("next_run_at"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("scheduled_tasks_site_idx").on(table.siteId),
    index("scheduled_tasks_next_run_idx").on(table.nextRunAt, table.status),
  ]
);

// ── Audit Log ───────────────────────────────────────────────────────────────

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteId: uuid("site_id").references(() => sites.id).notNull(),
    actorType: varchar("actor_type", { length: 20 }).notNull(), // user, ai, cron, addon
    actorId: varchar("actor_id", { length: 255 }), // user UUID, addon ID, "scheduler", etc.
    action: varchar("action", { length: 100 }).notNull(), // content.created, media.uploaded, site.settings_updated, etc.
    entityType: varchar("entity_type", { length: 50 }), // content, media, collection, site, navigation
    entityId: uuid("entity_id"),
    details: jsonb("details").default({}), // what changed (diff, old/new values, etc.)
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("audit_log_site_idx").on(table.siteId, table.createdAt),
    index("audit_log_entity_idx").on(table.entityType, table.entityId),
  ]
);

// ── AI History ──────────────────────────────────────────────────────────────

export const aiHistory = pgTable(
  "ai_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteId: uuid("site_id").references(() => sites.id).notNull(),
    turnId: uuid("turn_id").notNull(),
    taskType: varchar("task_type", { length: 50 }).notNull(),
    action: text("action").notNull(),
    suggestion: text("suggestion"),
    userDecision: varchar("user_decision", { length: 50 }),
    actionType: varchar("action_type", { length: 50 }),
    entityType: varchar("entity_type", { length: 50 }),
    entityId: uuid("entity_id"),
    previousState: jsonb("previous_state"),
    decidedAt: timestamp("decided_at"),
    usedFallback: integer("used_fallback").default(0),
    model: varchar("model", { length: 100 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("ai_history_site_idx").on(table.siteId),
    index("ai_history_undecided_idx").on(table.siteId, table.userDecision, table.actionType),
    index("ai_history_turn_idx").on(table.turnId),
  ]
);

// ── AI Jobs ────────────────────────────────────────────────────────────────
// Async job records for long-running AI work (Stitch page generation, screen
// imports). Cloudflare's 100s edge timeout breaks synchronous calls that take
// minutes, so the API enqueues a row, kicks off the work as a fire-and-forget
// promise, and returns the job id immediately. Clients poll status here.

export const aiJobs = pgTable(
  "ai_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteId: uuid("site_id").references(() => sites.id).notNull(),
    type: varchar("type", { length: 50 }).notNull(), // design-page, apply-stitch-screen
    status: varchar("status", { length: 20 }).notNull().default("pending"), // pending, processing, completed, failed
    requestPayload: jsonb("request_payload").default({}),
    result: jsonb("result"),
    error: text("error"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
  },
  (table) => [
    index("ai_jobs_site_idx").on(table.siteId, table.createdAt),
    index("ai_jobs_status_idx").on(table.status, table.createdAt),
  ]
);

// ── Form Submissions ────────────────────────────────────────────────────────

export const formSubmissions = pgTable(
  "form_submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteId: uuid("site_id").references(() => sites.id).notNull(),
    formIdentifier: varchar("form_identifier", { length: 255 }).notNull(),
    data: jsonb("data").notNull(),
    // File attachments (form-file-uploads add-on): [{ field, filename, path, size, contentType }]
    // where path is the object key in the private form-uploads bucket.
    attachments: jsonb("attachments").default([]).notNull(),
    submitterEmail: varchar("submitter_email", { length: 255 }),
    sourceUrl: varchar("source_url", { length: 2000 }),
    ipAddress: varchar("ip_address", { length: 45 }),
    // Webhook delivery tracking. null = no webhook configured for this form;
    // otherwise pending | success | failed.
    webhookStatus: varchar("webhook_status", { length: 20 }),
    webhookAttempts: integer("webhook_attempts").default(0).notNull(),
    webhookError: text("webhook_error"),
    webhookUpdatedAt: timestamp("webhook_updated_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("form_submissions_site_idx").on(table.siteId, table.createdAt),
    index("form_submissions_form_idx").on(table.siteId, table.formIdentifier),
  ]
);

export const supportTickets = pgTable(
  "support_tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteId: uuid("site_id").references(() => sites.id).notNull(),
    userId: uuid("user_id").references(() => users.id).notNull(),
    type: varchar("type", { length: 20 }).notNull(), // 'support' | 'feature_request'
    subject: varchar("subject", { length: 255 }).notNull(),
    body: text("body").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("open"), // open | in_progress | resolved | closed
    priority: varchar("priority", { length: 10 }).notNull().default("normal"), // low | normal | high
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("support_tickets_site_idx").on(table.siteId),
    index("support_tickets_status_idx").on(table.status, table.createdAt),
  ]
);

export const supportTicketComments = pgTable(
  "support_ticket_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id").references(() => supportTickets.id, { onDelete: "cascade" }).notNull(),
    authorId: uuid("author_id").references(() => users.id).notNull(),
    body: text("body").notNull(),
    isInternal: boolean("is_internal").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("support_ticket_comments_ticket_idx").on(table.ticketId, table.createdAt),
  ]
);

export const platformSettings = pgTable("platform_settings", {
  key: varchar("key", { length: 100 }).primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ── Import Jobs ─────────────────────────────────────────────────────────────
// Tracks long-running WordPress (WXR) import jobs. Analyze step creates the
// row; start step kicks off background processing. Clients poll status here.

export const importJobs = pgTable(
  "import_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteId: uuid("site_id").references(() => sites.id).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("pending"), // pending, analyzing, running, completed, failed
    progress: integer("progress").notNull().default(0),
    total: integer("total").notNull().default(0),
    options: jsonb("options").default({}),
    result: jsonb("result"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("import_jobs_site_idx").on(table.siteId, table.createdAt),
    index("import_jobs_status_idx").on(table.status, table.createdAt),
  ]
);

// ── Redirects ────────────────────────────────────────────────────────────────

export const redirects = pgTable(
  "redirects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteId: uuid("site_id").references(() => sites.id, { onDelete: "cascade" }).notNull(),
    fromPath: varchar("from_path", { length: 2000 }).notNull(),
    toUrl: varchar("to_url", { length: 2000 }).notNull(),
    statusCode: integer("status_code").notNull().default(301),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("redirects_site_from_idx").on(table.siteId, table.fromPath),
    index("redirects_site_idx").on(table.siteId, table.enabled),
  ],
);

// ── Platform Config ──────────────────────────────────────────────────────────
// Global platform configuration key/value store (JSONB values for flexibility).

export const platformConfig = pgTable("platform_config", {
  key: varchar("key", { length: 100 }).primaryKey(),
  value: jsonb("value").notNull(),
  description: text("description"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  updatedBy: varchar("updated_by", { length: 36 }),
});

// ── AI Usage ─────────────────────────────────────────────────────────────────
// Per-site usage counters for AI features, used to enforce free-tier limits.
// usageType values:
//   'chat_message'      — period=YYYY-MM-DD (daily cap)
//   'image_generation'  — period=YYYY-MM    (monthly cap)
//   'page_with_images'  — period='lifetime' (lifetime cap)

export const aiUsage = pgTable("ai_usage", {
  siteId: uuid("site_id").notNull().references(() => sites.id, { onDelete: "cascade" }),
  usageType: varchar("usage_type", { length: 50 }).notNull(),
  period: varchar("period", { length: 10 }).notNull(),
  count: integer("count").notNull().default(0),
}, (t) => [primaryKey({ columns: [t.siteId, t.usageType, t.period] })]);

// ── Promotions ───────────────────────────────────────────────────────────────

export const promotions = pgTable(
  "promotions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: varchar("code", { length: 100 }).notNull(),
    slug: varchar("slug", { length: 100 }),
    name: varchar("name", { length: 255 }).notNull(),
    type: varchar("type", { length: 30 }).notNull().default("free_trial"), // free_trial
    planOverride: varchar("plan_override", { length: 20 }).default("monthly"), // plan applied during promo
    trialDays: integer("trial_days").notNull().default(30),
    maxRedemptions: integer("max_redemptions"), // null = unlimited
    redemptionCount: integer("redemption_count").notNull().default(0),
    expiresAt: timestamp("expires_at"),
    isActive: boolean("is_active").notNull().default(true),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("promotions_code_idx").on(table.code),
    uniqueIndex("promotions_slug_idx").on(table.slug),
  ]
);

export const promoRedemptions = pgTable(
  "promo_redemptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    promoId: uuid("promo_id").references(() => promotions.id).notNull(),
    siteId: uuid("site_id").references(() => sites.id).notNull(),
    userId: uuid("user_id").references(() => users.id).notNull(),
    redeemedAt: timestamp("redeemed_at").defaultNow().notNull(),
    ipAddress: varchar("ip_address", { length: 45 }),
  },
  (table) => [
    index("promo_redemptions_promo_idx").on(table.promoId),
    index("promo_redemptions_site_idx").on(table.siteId),
  ]
);

// ── Add-ons (marketplace catalog + per-site entitlements) ────────────────────

export const addons = pgTable(
  "addons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: varchar("slug", { length: 100 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    tagline: varchar("tagline", { length: 255 }),
    description: text("description"),
    category: varchar("category", { length: 50 }),
    runtime: varchar("runtime", { length: 20 }).notNull().default("builtin"), // builtin | external (reserved for future sandbox)
    isFree: boolean("is_free").notNull().default(false),
    priceMonthlyCents: integer("price_monthly_cents"),
    priceAnnualCents: integer("price_annual_cents"),
    stripeProductId: varchar("stripe_product_id", { length: 255 }),
    stripePriceMonthlyId: varchar("stripe_price_monthly_id", { length: 255 }),
    stripePriceAnnualId: varchar("stripe_price_annual_id", { length: 255 }),
    status: varchar("status", { length: 20 }).notNull().default("draft"), // draft | published | archived
    sortOrder: integer("sort_order").notNull().default(0),
    configDefaults: jsonb("config_defaults").default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [uniqueIndex("addons_slug_idx").on(table.slug)]
);

export const siteAddons = pgTable(
  "site_addons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteId: uuid("site_id").references(() => sites.id).notNull(),
    addonId: uuid("addon_id").references(() => addons.id).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("active"), // active | suspended | removed
    config: jsonb("config").notNull().default({}),
    stripeSubscriptionItemId: varchar("stripe_subscription_item_id", { length: 255 }),
    installedBy: uuid("installed_by").references(() => users.id),
    installedAt: timestamp("installed_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("site_addons_site_addon_idx").on(table.siteId, table.addonId),
    index("site_addons_site_idx").on(table.siteId),
  ]
);
