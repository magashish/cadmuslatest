-- Replace pages-with-images AI limit with simple page/post count limits.
-- Free sites: up to 10 pages and 10 posts (manual or AI-created).
DELETE FROM platform_config WHERE key = 'free_pages_with_images';
INSERT INTO platform_config (key, value, description) VALUES
('free_max_pages', '10', 'Max total pages for free sites'),
('free_max_posts', '10', 'Max total posts for free sites')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, description = EXCLUDED.description;
