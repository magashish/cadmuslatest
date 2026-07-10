# Cadmus — Local Development Setup

Welcome to Cadmus, an AI-native website platform (a modern successor to WordPress).
This guide gets a new developer from zero to a running local environment.

If anything here is out of date, the source of truth is `CLAUDE.md`, `docker-compose.yml`,
`.env.example`, and each app's `package.json`.

---

## 1. Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| **Node.js** | **22.x** | CI builds on Node 22. Use `nvm` or `fnm` if you juggle versions. |
| **pnpm** | **10.32.1** | Don't `npm i -g pnpm` — use Corepack (below). It's pinned via `packageManager`. |
| **Docker** | any recent | Runs Postgres locally. Docker Desktop on macOS/Windows. |
| **Git** + GitHub access | — | You'll need write access to `frobroweb/cadmus`. |

Enable pnpm via Corepack (ships with Node):

```bash
corepack enable
```

You do **not** need `gcloud`, GCP credentials, or any production secrets for local development.
Deploys happen automatically in CI — see [Deploys](#9-deploys--what-you-dont-need-locally).

---

## 2. Repo layout

Monorepo managed with **pnpm workspaces + Turborepo**.

```
apps/
  api         Hono API server (Node + TS)              → http://localhost:3001
  web         Astro frontend (public site visitors see) → http://localhost:4321
  admin       React + Vite admin dashboard             → http://localhost:3000
  dashboard   React + Vite platform admin (cadmus_admin)→ http://localhost:3002
  scanner     Separate media-moderation service
packages/
  ai          AI provider abstraction (router, providers, prompts)
  db          Drizzle ORM schema + Postgres client + migrations
  cloud       Cloud provider abstractions (storage, DNS, email, secrets)
  shared      Shared types (SiteBrief, ContentType, …) + HTML helpers
```

---

## 3. First-time setup

```bash
# 1. Clone
git clone git@github.com:frobroweb/cadmus.git
cd cadmus

# 2. Enable pnpm + install all workspace deps
corepack enable
pnpm install

# 3. Start Postgres (pgvector) in Docker
docker compose up -d

# 4. Create your local env file
cp .env.example .env
#   then edit .env — see section 4 below. The DATABASE_URL default already
#   matches the Docker Postgres, so the minimum to edit is ANTHROPIC_API_KEY.

# 5. Apply database migrations to your local DB
pnpm db:migrate:run

# 6. Start everything (Turborepo runs all apps in parallel)
pnpm dev
```

Then open **http://localhost:3000** (admin), click **Sign up**, and create an account —
that provisions your first local site and walks you through onboarding.

> Onboarding generates pages with AI, so you need a working `ANTHROPIC_API_KEY` for the
> full flow.

---

## 4. Environment variables (`.env`)

`.env` lives at the repo root and is git-ignored. Copy it from `.env.example`. For **local
dev**, most values can stay empty — here's what actually matters:

| Variable | Local dev | Notes |
|----------|-----------|-------|
| `DATABASE_URL` | **preset, leave as-is** | `postgresql://cadmus:cadmus@localhost:5432/cadmus` — matches Docker. |
| `PORT` | `3001` | API port. The admin/dashboard Vite servers proxy `/api` here. |
| `JWT_SECRET` | optional | Dev has a built-in fallback, but set one for parity: `openssl rand -base64 32`. **Required** in prod (the API refuses to start without it). |
| `ANTHROPIC_API_KEY` | **set your own** | Needed for AI features (onboarding, AI chat, copy, etc.). Use your own key — don't share prod keys. |
| `GEMINI_API_KEY` | optional | Alternate/fallback AI provider. At least one AI key is required for AI features. |
| `GCS_BUCKET` | optional | Media uploads need a Google Cloud Storage bucket. Fine to skip until you work on media. |
| `MAILGUN_API_KEY` / `MAILGUN_DOMAIN` | optional | Outbound email (invites, password reset, etc.). Without it, emails are skipped/logged. |
| `PUBLIC_API_URL` | `http://localhost:3001` | Astro (`web`) build-time API URL. |
| `PUBLIC_SITE_ID` | `demo` | Dev-only fallback site for the public `web` app. |
| `VITE_API_URL` | leave empty | In dev the Vite proxy handles `/api`, so relative requests work. |
| `GCP_*`, `*_SERVICE_NAME`, `*_BUCKET` | ignore | Used by deploy scripts only, not local dev. |

**Minimum to be productive locally:** the preset `DATABASE_URL` + your own `ANTHROPIC_API_KEY`.

---

## 5. Running the apps

`pnpm dev` (from the repo root) starts everything via Turborepo. Individual apps:

```bash
pnpm --filter @cadmus/api dev        # API only        (tsx watch)  :3001
pnpm --filter @cadmus/admin dev      # Admin only       (vite)      :3000
pnpm --filter @cadmus/dashboard dev  # Dashboard only   (vite)      :3002
pnpm --filter @cadmus/web dev        # Public site only (astro)     :4321
```

| App | URL | What it is |
|-----|-----|-----------|
| Admin | http://localhost:3000 | Where site owners build/edit their site. Start here. |
| API | http://localhost:3001 | Backend. Health check: `GET /health`. |
| Dashboard | http://localhost:3002 | Platform admin (cadmus_admin only) — sites, partners, versions, etc. |
| Public web | http://localhost:4321 | What end visitors see (rendered from a site's content). |

Admin and Dashboard proxy `/api/*` to the API on `:3001`, so you don't need CORS config locally.

---

## 6. Database

Postgres runs in Docker (`pgvector/pgvector:pg17`), user/pass/db all `cadmus`, on `:5432`.

```bash
docker compose up -d          # start
docker compose down           # stop (keeps data)
docker compose down -v        # stop + wipe data (fresh start)

pnpm db:migrate:run           # apply committed migrations to your local DB
pnpm db:studio                # Drizzle Studio — browse/edit data in a GUI
```

**Schema changes:** edit `packages/db/src/schema.ts`, then generate a migration:

```bash
pnpm db:generate              # creates the SQL + journal entry
pnpm db:migrate:run           # apply it locally
```

> ⚠️ Always use `pnpm db:generate` for migrations — never hand-write the journal `when`
> timestamp. A wrong timestamp causes migrations to be silently skipped.

If your local DB gets into a weird state, `docker compose down -v && docker compose up -d`
then `pnpm db:migrate:run` gives you a clean slate.

---

## 7. Tests

Tests use **Vitest** and a **real Postgres** — the API test setup creates/drops a separate
`cadmus_test` database automatically and runs the real migrations, so just have Docker up:

```bash
docker compose up -d
pnpm --filter @cadmus/api test          # run the API suite
pnpm --filter @cadmus/api exec vitest    # watch mode
```

`ECONNREFUSED ... 5432` from a test run means Postgres isn't running — start Docker.

---

## 8. Conventions

- **TypeScript everywhere**, **ESM** (`"type": "module"`).
- **Drizzle ORM** for all DB access; **Hono** for API routing.
- **Every query is scoped to a `siteId`** — site-level data isolation is a hard rule.
- **Every mutation is written to the audit log** (actor, action, details).
- **Branching:** work happens on `dev`. Pushing to `dev` auto-deploys to the dev environment
  via GitHub Actions — so stack your commits and push intentionally (avoid pushing every
  commit). Production deploys go out via version tags, not by pushing.
- **Don't deploy manually** — CI owns deploys. There are no manual `gcloud` deploy steps.
- Before opening a PR: `pnpm build` and `pnpm --filter @cadmus/api test` should pass.

---

## 9. Deploys & what you DON'T need locally

- **Dev** auto-deploys on push to the `dev` branch.
- **Prod** deploys via a version tag (and a manual DB-migrate workflow for schema changes).
- You do **not** need GCP access, the `gcloud` CLI, or any production secrets to develop.
  Everything runs against local Docker Postgres + your own AI key.

---

## 10. Troubleshooting

| Symptom | Fix |
|---------|-----|
| `ECONNREFUSED 127.0.0.1:5432` | Postgres isn't running → `docker compose up -d`. |
| Port already in use (3000/3001/3002/4321) | Another process (or a stale `pnpm dev`) holds it. Kill it or change `PORT`/Vite `server.port`. |
| AI features error out | Missing/invalid `ANTHROPIC_API_KEY` in `.env`. |
| API won't start in prod-like mode | `JWT_SECRET` not set — it's required outside dev. |
| `pnpm` not found / wrong version | `corepack enable` (don't install pnpm globally). |
| Migrations "did nothing" | Check the journal — never hand-edit it; regenerate with `pnpm db:generate`. |
| Media upload fails locally | `GCS_BUCKET` not configured — expected unless you're working on media. |

---

## 11. Quick reference

```bash
corepack enable && pnpm install     # one-time
docker compose up -d                # start Postgres
cp .env.example .env                # then add ANTHROPIC_API_KEY
pnpm db:migrate:run                 # set up the DB
pnpm dev                            # run all apps
# → admin http://localhost:3000  |  api :3001  |  dashboard :3002  |  web :4321
```

Welcome aboard. 
