# Cadmus

AI-native website platform — a modern successor to WordPress.

## Project Structure

Monorepo managed with pnpm workspaces + Turborepo.

- `apps/api` — Hono API server (Node + TypeScript)
- `apps/web` — Astro frontend (public-facing site visitors see)
- `apps/admin` — React + Vite admin dashboard (sidebar nav, AI chat, content editor, media library, settings)
- `packages/ai` — AI provider abstraction (router, providers, prompt layer)
- `packages/db` — Drizzle ORM schema + Postgres client
- `packages/cloud` — Cloud provider abstractions (storage, DNS, scheduling, secrets)
- `packages/shared` — Shared types (SiteBrief, ContentType, etc.)

## Dev Setup

```bash
pnpm install
docker compose up -d   # Postgres with pgvector
pnpm dev               # Starts all apps
```

## Key Architecture Decisions

- **Content model**: Page, Post, Product as built-in types. Structured blocks (not serialized HTML). Versioned.
- **Collections**: Replace WP taxonomies. Flexible, typed, nestable.
- **AI routing**: Task-based (copywriting, seo, image, interview, analysis, embedding, alt-text). Primary + fallback per task type.
- **AI identity**: Expert marketer/SEO/CRO consultant, not a yes-man. Pushes back with reasoning. User has final say.
- **Add-ons**: Curated marketplace (App Store model). Sandboxed in Cloud Run. API-integrated, not code-injected.
- **Target platform**: Google Cloud (Cloud Run, Cloud SQL, Cloud Storage).
- **Cloud portability**: Every cloud service behind a provider interface (`@cadmus/cloud`). App code never calls cloud SDKs directly.
- **Security**: Site-level data isolation (every query scoped to siteId), rate limiting, input sanitization, add-on sandboxing.
- **Audit log**: Every mutation logged with actor (user, AI, cron, add-on), action, and details.
- **Multi-tenancy**: Wildcard subdomain routing (*.cadmus.digital), tenant middleware resolves site from hostname or x-site-id header.

## Conventions

- TypeScript throughout
- ESM modules (`"type": "module"`)
- Drizzle ORM for database
- Hono for API routing
