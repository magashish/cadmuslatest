-- Add promo fields to sites table
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "promo_ends_at" timestamp;
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "promo_code" varchar(100);

-- Promotions table
CREATE TABLE IF NOT EXISTS "promotions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "code" varchar(100) NOT NULL,
  "slug" varchar(100),
  "name" varchar(255) NOT NULL,
  "type" varchar(30) NOT NULL DEFAULT 'free_trial',
  "plan_override" varchar(20) DEFAULT 'monthly',
  "trial_days" integer NOT NULL DEFAULT 30,
  "max_redemptions" integer,
  "redemption_count" integer NOT NULL DEFAULT 0,
  "expires_at" timestamp,
  "is_active" boolean NOT NULL DEFAULT true,
  "notes" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "promotions_code_idx" ON "promotions" ("code");
CREATE UNIQUE INDEX IF NOT EXISTS "promotions_slug_idx" ON "promotions" ("slug") WHERE "slug" IS NOT NULL;

-- Promo redemptions table
CREATE TABLE IF NOT EXISTS "promo_redemptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "promo_id" uuid NOT NULL REFERENCES "promotions"("id"),
  "site_id" uuid NOT NULL REFERENCES "sites"("id"),
  "user_id" uuid NOT NULL REFERENCES "users"("id"),
  "redeemed_at" timestamp NOT NULL DEFAULT now(),
  "ip_address" varchar(45)
);

CREATE INDEX IF NOT EXISTS "promo_redemptions_promo_idx" ON "promo_redemptions" ("promo_id");
CREATE INDEX IF NOT EXISTS "promo_redemptions_site_idx" ON "promo_redemptions" ("site_id");

-- Seed aisummit2026 promo
INSERT INTO "promotions" ("code", "slug", "name", "type", "plan_override", "trial_days", "max_redemptions", "expires_at", "is_active", "notes")
VALUES (
  'aisummit2026',
  'aisummit2026',
  'AI Summit 2026',
  'free_trial',
  'monthly',
  30,
  NULL,
  '2026-12-31 23:59:59',
  true,
  '30 days Pro free for AI Summit 2026 attendees. No credit card required.'
)
ON CONFLICT ("code") DO NOTHING;
