import postgres from "postgres";
import path from "node:path";
import { beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db } from "@cadmus/db";

const adminUrl = "postgresql://cadmus:cadmus@localhost:5432/postgres";
const TEST_DB = "cadmus_test";
const testUrl = `postgresql://cadmus:cadmus@localhost:5432/${TEST_DB}`;

// Drop + recreate the test database so its schema is rebuilt from the real
// Drizzle migrations on every run. Previously this file hand-maintained a
// subset of the schema in raw SQL, which silently drifted from the production
// schema (missing columns like sites.plan and whole tables like site_members).
// Driving it from ./packages/db/drizzle keeps tests honest against the real DDL.
async function resetTestDb() {
  const admin = postgres(adminUrl);
  await admin`
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE datname = ${TEST_DB} AND pid <> pg_backend_pid()
  `;
  await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();
}

async function runMigrations() {
  // vitest runs with cwd = apps/api; migrations live in packages/db/drizzle.
  const migrationsFolder = path.resolve(process.cwd(), "../../packages/db/drizzle");
  const client = postgres(testUrl, { max: 1 });
  try {
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    await client.end();
  }
}

// Truncate everything between tests. We discover tenant tables dynamically so we
// don't have to keep a hand-maintained list in sync with the schema.
async function discoverTables(): Promise<string[]> {
  const rows = await db.execute<{ tablename: string }>(sql`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '__drizzle_migrations'
  `);
  return (rows as unknown as { tablename: string }[]).map((r) => r.tablename);
}

let cachedTables: string[] | null = null;

async function truncateAll() {
  if (!cachedTables) cachedTables = await discoverTables();
  if (cachedTables.length === 0) return;
  const list = cachedTables.map((t) => `"${t}"`).join(", ");
  await db.execute(sql.raw(`TRUNCATE ${list} RESTART IDENTITY CASCADE`));
}

// Run once: rebuild DB from migrations.
await resetTestDb();
await runMigrations();

// Truncate between every test.
beforeEach(async () => {
  await truncateAll();
});
