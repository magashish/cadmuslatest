# Cadmus Pre-Launch Audit

Last updated 2026-04-23. Target launch: May 1, 2026.

## Status since 2026-04-21

All 7 original BLOCKERs are resolved. Focus now is the SHOULD-HAVE tier (hardening + a couple of UI gaps) and NICE-TO-HAVEs that may slip post-launch.

---

## Bucket 1: Features

### Auth Flows — Partial
- **Complete**: login, signup, forgot-password, reset-password, change-password, JWT 7-day expiry, password reset one-time tokens with 1h expiry, brute-force rate limit on login (10 failures / 15min).
- **Gap**: No email verification enforcement. Users can sign up with any email and perform all actions immediately.
- **Gap**: No JWT refresh token — users re-authenticate every 7 days.
- **Severity**: SHOULD-HAVE (verify email) / NICE-TO-HAVE (refresh)

### Billing — Complete
- `apps/api/src/routes/billing.ts`, `apps/api/src/lib/stripe.ts`, `apps/api/src/routes/webhooks.ts`
- 14-day trials, subscription lifecycle, payment methods, checkout/portal, cancel/reactivate, billing transfer to partners or users.
- Webhooks: subscription.created/updated/deleted, invoice.payment_succeeded/failed, payment_method.attached/detached, checkout.session.completed.
- Auto-suspend on past_due, auto-reinstate on payment success. Referral attribution on first payment.

### Custom Domain Provisioning — Complete
- Backend: `apps/api/src/routes/sites.ts` (connect, status, disconnect).
- Admin UI: `apps/admin/src/pages/SiteSettings.tsx:201-288` — input form, DNS instructions, status polling, disconnect button, SSL tracking, payment-method gate.

### Site Preview in Admin — Not Found
- **Gap**: No iframe or preview mechanism in `apps/admin/src`.
- **Severity**: SHOULD-HAVE

### Logo — Complete
- Rendering: `apps/web/src/layouts/BaseLayout.astro` (lines 85, 92, 160).
- Admin UI: `apps/admin/src/pages/Theme.tsx:117-322` — upload/change/remove via MediaPicker.

### Social Links — Partial
- Schema supports `socialLinks` in site settings; nav-wiring picks them up in `packages/shared/src/html/nav-wiring.ts:202-265`; AI extracts them during Stitch import.
- **Gap**: No dedicated admin UI to set or edit social links manually.
- **Severity**: SHOULD-HAVE

### SEO — Complete
- OG/Twitter tags in `apps/web/src/layouts/BaseLayout.astro`.
- JSON-LD schema in `apps/web/src/lib/schema.ts` (Organization, WebPage, graph wrapper).
- Sitemap: `apps/web/src/pages/sitemap.xml.ts` (dynamic, cached).
- Robots: `apps/web/src/pages/robots.txt.ts`.

### Forms — Complete
- Backend: `apps/api/src/routes/formSubmissions.ts` (CRUD, CSV export, filters).
- Admin viewer: `apps/admin/src/pages/FormSubmissions.tsx`.
- Spam protection in `apps/api/src/routes/public.ts:187-360` — honeypot + timing check + per-IP rate limit (5/min).
- Email notifications to site admin on submission; confirmation to submitter.

### Media — Partial
- Upload, image optimization, alt text, deletion all present.
- **Gap**: No MAX_FILE_SIZE enforcement in `apps/api/src/routes/media.ts`.
- **Severity**: SHOULD-HAVE

### Search — Missing
- **Severity**: NICE-TO-HAVE

### Onboarding Completion — Partial
- Flow exists: `apps/admin/src/pages/Onboarding.tsx`.
- **Gap**: No verified state persistence if user closes tab or refreshes mid-interview.
- **Severity**: SHOULD-HAVE

### Multi-User Team — Partial
- Roles present (owner, admin, editor, viewer).
- **Gap**: Role enforcement has not been audited across all endpoints.
- **Severity**: SHOULD-HAVE

### Platform Operations Dashboard — Complete
- `apps/dashboard/` — separate SPA at `dashboard.cadmus.digital`, gated by `globalRole: "cadmus_admin"`.
- Cross-tenant views: sites, partners, referrals, users, stats.
- Deployed via GCS + Cloudflare Worker; build job in `.github/workflows/deploy.yml`.

---

## Bucket 2: Hardening

### Rate Limiting — Partial
- Auth login: 10 failures / 15min per IP (`apps/api/src/routes/auth.ts:13`). Complete.
- Form submissions: 5/min per IP (`public.ts`). Complete.
- **Gap**: No rate limit on AI endpoints (expensive, susceptible to abuse).
- **Severity**: SHOULD-HAVE

### Error Monitoring — Missing
- **Gap**: No Sentry or equivalent. Errors go to console only.
- **Severity**: SHOULD-HAVE

### Structured Logging — Missing
- **Gap**: Inconsistent `console.log` / `console.error` throughout. No JSON format, no aggregation.
- **Severity**: SHOULD-HAVE

### Error Boundary (Admin) — Missing
- **Gap**: No ErrorBoundary wrapping router or layout in `apps/admin/src`. Component crashes blank the UI.
- **Severity**: SHOULD-HAVE

### Health Checks — Minimal
- Only `GET /api/health` → `{ status: "ok" }`.
- **Gap**: No DB, Stripe, Cloud Storage, or AI provider connectivity checks.
- **Severity**: SHOULD-HAVE

### Monitoring / Alerting — Missing
- **Gap**: No Cloud Monitoring alerts for error rate, latency, or custom metrics.
- **Severity**: SHOULD-HAVE

### Backups — Missing
- **Gap**: No automated DB backup procedure documented or implemented.
- **Severity**: SHOULD-HAVE (Cloud SQL auto-backups likely enabled — verify and document).

### Tests — Partial
- 9 test files in `apps/api/src/routes/__tests__/`.
- **Gap**: CI builds but does not run tests. No coverage metrics.
- **Severity**: NICE-TO-HAVE

### Migration Safety — Partial
- Drizzle migrations in `packages/db/drizzle/`.
- **Gap**: No documented zero-downtime pattern (dual-write, canary).
- **Severity**: SHOULD-HAVE

### Audit Log — Partial
- Logging present on most mutations. No retention policy — grows indefinitely.
- **Severity**: SHOULD-HAVE (retention) / NICE-TO-HAVE (completeness audit)

### TypeScript Strictness — Complete
- `tsconfig.base.json` has `"strict": true`.

---

## Bucket 3: Security

### Multi-Tenant Isolation — Complete
- `apps/api/src/routes/content.ts:70-92` — GET `/:id` now scopes to siteId.
- All other routes inherit siteId from tenant middleware.

### XSS — Complete
- `apps/web/src/lib/sanitize.ts` uses `sanitize-html`.
- Applied in TextSection, FAQ, Embed, Map blocks via `sanitizeRichText()` / `sanitizeEmbed()`.
- HtmlBlock raw HTML is opt-in, author-controlled.

### Auth / Session — Complete (except email verification)
- JWT 7-day HS256 + HMAC-SHA512.
- PBKDF2 100k iterations with salt for passwords.
- Reset tokens one-time, 1h expiry.
- **Gap**: No email verification flag.
- **Severity**: SHOULD-HAVE

### Brute-Force Protection — Complete
- Login rate limit in place.

### Password Reset Token Security — Partial
- One-time use + 1h expiry enforced.
- **Gap**: Tokens stored plaintext; if DB is compromised, attacker can use unexpired tokens. Should be hashed before storage.
- **Severity**: SHOULD-HAVE

### SQL Injection — Safe
- Drizzle parameterizes everything.

### CSRF — N/A
- Token-based auth via Authorization header, not cookies.

### AI Tool Authorization — Partial
- Tools trust the authenticated session context.
- **Gap**: No per-invocation role re-check before tool execution.
- **Severity**: SHOULD-HAVE

### Input Validation — Partial
- Manual validation in routes. No Zod/Valibot layer.
- **Severity**: SHOULD-HAVE

### CSP — Deferred
- Not added to Cloudflare Worker.
- **Severity**: SHOULD-HAVE

### Email Verification — Missing
- **Gap**: No `emailVerified` field. Unverified users have full access.
- **Severity**: SHOULD-HAVE

### Secrets Management — Complete
- Env vars for all keys; periodic audit recommended for accidental logging.

### Add-on Sandbox — Post-MVP
- No add-on code yet; marketplace is aspirational.

---

## Summary

### BLOCKERs — 0 (all 7 resolved)

### SHOULD-HAVEs — 13 open
1. Social links admin UI
2. Error boundary in admin
3. AI endpoint rate limiting
4. Deep health checks (DB, Stripe, Storage)
5. Error monitoring (Sentry or equivalent)
6. Structured logging
7. Cloud Monitoring alerts
8. DB backup procedure (verify + document)
9. Migration safety patterns
10. Audit log retention policy
11. Password reset token hashing
12. AI tool role re-validation per invocation
13. Input validation layer (Zod)
14. Email verification enforcement
15. CSP headers
16. Site preview in admin
17. Media upload size limit
18. Onboarding state persistence
19. Team role enforcement audit

### NICE-TO-HAVEs — 4
1. JWT refresh tokens
2. Site search
3. CI test gating + coverage
4. Audit log completeness verification

### Plus
- Stripe 30-day trial promo link for June AI summit (1-2 hours, independent).

**Go / no-go for May 1**: go. No BLOCKERs remain. Recommended pre-launch subset of SHOULD-HAVEs: email verification, AI rate limit, Sentry, deep health check, error boundary, CSP, password reset hashing. The rest can follow in the first weeks after launch.
