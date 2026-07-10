ALTER TABLE "ai_history" ADD COLUMN "action_type" varchar(50);--> statement-breakpoint
ALTER TABLE "ai_history" ADD COLUMN "entity_type" varchar(50);--> statement-breakpoint
ALTER TABLE "ai_history" ADD COLUMN "entity_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_history" ADD COLUMN "previous_state" jsonb;--> statement-breakpoint
ALTER TABLE "ai_history" ADD COLUMN "decided_at" timestamp;--> statement-breakpoint
CREATE INDEX "ai_history_undecided_idx" ON "ai_history" USING btree ("site_id","user_decision","action_type");