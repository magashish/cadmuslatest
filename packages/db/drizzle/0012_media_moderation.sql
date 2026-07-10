ALTER TABLE "media" ADD COLUMN "moderation_status" varchar(20) DEFAULT 'approved' NOT NULL;
ALTER TABLE "media" ADD COLUMN "moderation_scores" jsonb DEFAULT '{}';
ALTER TABLE "media" ADD COLUMN "staging_path" text;
CREATE INDEX "media_moderation_status_idx" ON "media" ("moderation_status");
