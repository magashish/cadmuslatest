# @cadmus/db

Drizzle ORM schema + Postgres client. Source of truth for the database shape is [`src/schema.ts`](src/schema.ts); generated SQL lives in [`drizzle/`](drizzle/) and is the source of truth for what actually runs in production.

## Changing the schema

1. Edit `src/schema.ts`.
2. Generate a migration:
   ```bash
   pnpm --filter @cadmus/db db:generate
   ```
   This produces a new `drizzle/NNNN_<name>.sql` file and updates `drizzle/meta/_journal.json`.
3. Review the SQL. If drizzle-kit asks to disambiguate a rename, pick the correct option — the choice is encoded into the SQL file, not replayed at apply time.
4. Commit both the schema change and the generated SQL in the same commit.
5. On deploy (push to `dev` or production promotion), CI runs `pnpm db:migrate:run` which applies any migration whose hash is not yet in `drizzle.__drizzle_migrations`.

Do **not** rely on `drizzle-kit push` for deployed environments — it is interactive for data-integrity changes (e.g. adding a unique constraint to a populated table) and has no safe way to be driven from CI.

## Local dev

```bash
docker compose up -d   # from repo root
pnpm --filter @cadmus/db db:migrate:run
```

Local DB resets are fine via `docker compose down -v` followed by `db:migrate:run`.

## Baselining an existing database

If a database was previously managed via `drizzle-kit push` (no `drizzle.__drizzle_migrations` table yet), run once:

```bash
DATABASE_URL=... pnpm --filter @cadmus/db db:baseline
```

This inserts a row per existing migration into `drizzle.__drizzle_migrations` **without running the SQL**. After baselining, `db:migrate:run` is a no-op until a new migration is generated.

Or via the `DB Migrate` GitHub workflow with `mode=baseline`.

## Recovering from schema drift

If a deployed DB falls out of sync with `drizzle/*.sql` (e.g. someone pushed a column manually), generate a reconciling migration locally:

1. Make the schema change in `src/schema.ts` if needed.
2. Run `db:generate` — drizzle will produce a migration bringing the DB in line.
3. Commit and deploy.

Destructive drift (columns/tables that exist in prod but not in schema) still requires human review before committing the generated SQL.
