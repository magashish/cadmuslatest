ALTER TABLE "form_submissions" ADD COLUMN "webhook_status" varchar(20);--> statement-breakpoint
ALTER TABLE "form_submissions" ADD COLUMN "webhook_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD COLUMN "webhook_error" text;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD COLUMN "webhook_updated_at" timestamp;