UPDATE "sites" s
SET "settings" = COALESCE(s."settings", '{}'::jsonb) || jsonb_build_object(
  'formDefaults',
  COALESCE(s."settings"->'formDefaults', '{}'::jsonb) || jsonb_build_object('notificationEmail', u."email")
)
FROM "site_members" sm
JOIN "users" u ON u."id" = sm."user_id"
WHERE sm."site_id" = s."id"
  AND sm."role" = 'owner'
  AND COALESCE(s."settings"->'formDefaults'->>'notificationEmail', '') = ''
  AND u."email" IS NOT NULL
  AND u."email" <> '';
