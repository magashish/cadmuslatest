INSERT INTO platform_config (key, value, description) VALUES
('free_pages_with_images', '5', 'Max AI-designed pages with images for free sites (lifetime)'),
('free_chat_messages_daily', '10', 'Max AI chat messages per day for free sites'),
('free_images_monthly', '10', 'Max AI-generated images per month for free sites'),
('free_storage_mb', '250', 'Storage limit in MB for free sites'),
('free_form_notifications_monthly', '100', 'Max outbound form notification emails per month for free sites'),
('free_team_members', '1', 'Max team members for free sites (owner only)')
ON CONFLICT (key) DO NOTHING;
