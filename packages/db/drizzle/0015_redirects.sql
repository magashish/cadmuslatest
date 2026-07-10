CREATE TABLE IF NOT EXISTS "redirects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"from_path" varchar(2000) NOT NULL,
	"to_url" varchar(2000) NOT NULL,
	"status_code" integer NOT NULL DEFAULT 301,
	"enabled" boolean NOT NULL DEFAULT true,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "redirects_site_id_from_path_unique" UNIQUE("site_id","from_path")
);
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
