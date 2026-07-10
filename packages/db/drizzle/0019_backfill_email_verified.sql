-- Mark all existing users as email-verified.
-- Users created before the email verification feature was introduced never
-- went through the verification flow, so their emailVerifiedAt is NULL.
-- Setting it to their creation timestamp grandfathers them in without
-- requiring them to re-verify an email they signed up with long ago.
UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL;
