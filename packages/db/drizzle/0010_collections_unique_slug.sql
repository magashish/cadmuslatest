CREATE UNIQUE INDEX "collections_site_slug_idx" ON "collections" USING btree ("site_id","slug");
