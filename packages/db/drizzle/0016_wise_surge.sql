DROP TABLE IF EXISTS "ai_usage";
--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"site_id" uuid NOT NULL,
	"usage_type" varchar(50) NOT NULL,
	"period" varchar(10) NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ai_usage_site_id_usage_type_period_pk" PRIMARY KEY("site_id","usage_type","period")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_config" (
	"key" varchar(100) PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"description" text,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"updated_by" varchar(36)
);
--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "file_size" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "thumbnail_url" text;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "moderation_status" varchar(20) DEFAULT 'approved' NOT NULL;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "moderation_scores" jsonb DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "moderation_reason" text;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "moderation_source" varchar(20);--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "blocked_at" timestamp;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "staging_path" text;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "plan" varchar(20) DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "plan_ends_at" timestamp;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "previous_subdomain" varchar(100);--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "previous_subdomain_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email_verified_at" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email_verification_token" varchar(64);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email_verification_token_expires_at" timestamp;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "redirects" ADD CONSTRAINT "redirects_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "redirects_site_from_idx" ON "redirects" USING btree ("site_id","from_path");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "redirects_site_idx" ON "redirects" USING btree ("site_id","enabled");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "collections_site_slug_idx" ON "collections" USING btree ("site_id","slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_moderation_status_idx" ON "media" USING btree ("moderation_status");
