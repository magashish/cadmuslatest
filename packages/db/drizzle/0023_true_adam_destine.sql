CREATE TABLE "addons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(100) NOT NULL,
	"name" varchar(255) NOT NULL,
	"tagline" varchar(255),
	"description" text,
	"category" varchar(50),
	"runtime" varchar(20) DEFAULT 'builtin' NOT NULL,
	"is_free" boolean DEFAULT false NOT NULL,
	"price_monthly_cents" integer,
	"price_annual_cents" integer,
	"stripe_product_id" varchar(255),
	"stripe_price_monthly_id" varchar(255),
	"stripe_price_annual_id" varchar(255),
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"config_defaults" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_addons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"addon_id" uuid NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stripe_subscription_item_id" varchar(255),
	"installed_by" uuid,
	"installed_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "site_addons" ADD CONSTRAINT "site_addons_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_addons" ADD CONSTRAINT "site_addons_addon_id_addons_id_fk" FOREIGN KEY ("addon_id") REFERENCES "public"."addons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_addons" ADD CONSTRAINT "site_addons_installed_by_users_id_fk" FOREIGN KEY ("installed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "addons_slug_idx" ON "addons" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "site_addons_site_addon_idx" ON "site_addons" USING btree ("site_id","addon_id");--> statement-breakpoint
CREATE INDEX "site_addons_site_idx" ON "site_addons" USING btree ("site_id");