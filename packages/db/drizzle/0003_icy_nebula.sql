ALTER TABLE "ai_history" ADD COLUMN "turn_id" uuid;--> statement-breakpoint
UPDATE "ai_history" SET "turn_id" = "id" WHERE "turn_id" IS NULL;--> statement-breakpoint
ALTER TABLE "ai_history" ALTER COLUMN "turn_id" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "ai_history_turn_idx" ON "ai_history" USING btree ("turn_id");