# Cadmus

**An AI-native website platform — a modern successor to WordPress.**

Cadmus builds, writes, and optimizes websites with AI at every step: content generation,
editing, SEO, and images are native, not bolt-ons. Built from scratch (not headless
WordPress), it targets non-technical users with security, performance, and stability by
default.

## Quick start

```bash
corepack enable && pnpm install     # one-time
docker compose up -d                # start Postgres
cp .env.example .env                # then add your ANTHROPIC_API_KEY
pnpm db:migrate:run                 # set up the database
pnpm dev                            # run all apps
```

Then open **http://localhost:3000** and sign up.

👉 **Full instructions: [SETUP.md](./SETUP.md)** — prerequisites, env vars, ports, tests,
and troubleshooting.

## Monorepo layout

pnpm workspaces + Turborepo.

| Path | What it is |
|------|-----------|
| `apps/api` | Hono API server (Node + TypeScript) — `:3001` |
| `apps/web` | Astro frontend (the public site visitors see) — `:4321` |
| `apps/admin` | React + Vite admin dashboard (site owners) — `:3000` |
| `apps/dashboard` | React + Vite platform admin (cadmus_admin) — `:3002` |
| `apps/scanner` | Media-moderation service |
| `packages/ai` | AI provider abstraction (router, providers, prompts) |
| `packages/db` | Drizzle ORM schema + Postgres client + migrations |
| `packages/cloud` | Cloud provider abstractions (storage, DNS, email, secrets) |
| `packages/shared` | Shared types + HTML helpers |

## Tech stack

TypeScript · ESM · Hono · Astro · React + Vite · Drizzle ORM + Postgres (pgvector) ·
Turborepo · Google Cloud (Cloud Run, Cloud SQL, Cloud Storage).

## Docs & reference

- **[SETUP.md](./SETUP.md)** — local development setup.
- **[CLAUDE.md](./CLAUDE.md)** — architecture decisions and project conventions.
- **[todo.txt](./todo.txt)** — roadmap / backlog.

## Deploys

Pushing to `dev` auto-deploys to the dev environment via GitHub Actions; production ships
via version tags. Deploys are owned by CI — there are no manual deploy steps.
