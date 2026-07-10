ALTER TABLE "media" ADD COLUMN "moderation_reason" text;
ALTER TABLE "media" ADD COLUMN "moderation_source" varchar(20);
ALTER TABLE "media" ADD COLUMN "blocked_at" timestamp;
