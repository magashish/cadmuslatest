-- Trimmed to only the genuinely-new DDL. db:generate re-emitted promotions/
-- promo_redemptions/sites.promo_*/ai_usage because the Drizzle snapshot was
-- frozen at 0016 while migrations 0017-0020 were hand-written; those objects
-- already exist in every environment (created idempotently by 0020_promotions),
-- so re-running their CREATE/ADD here would fail. The regenerated 0021 snapshot
-- now reflects the full schema, so future generates diff cleanly.
ALTER TABLE "users" ADD COLUMN "invite_token_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "invite_token_expiry" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "token_version" integer DEFAULT 0 NOT NULL;
