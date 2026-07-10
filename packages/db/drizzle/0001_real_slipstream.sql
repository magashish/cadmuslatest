ALTER TABLE "sites" ADD COLUMN "suspension_source" varchar(20);--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "has_ever_paid" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Backfill: any currently-active subscription has clearly paid at least once,
-- so mark it as such. Without this, existing subs would be misrouted as
-- "trial-expired" on the next payment failure.
UPDATE "subscriptions" SET "has_ever_paid" = true WHERE "status" = 'active';