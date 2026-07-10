/**
 * Baseline an existing database for drizzle-kit migrate.
 *
 * Marks every migration listed in drizzle/meta/_journal.json as already
 * applied by inserting its (hash, created_at) into drizzle.__drizzle_migrations
 * without executing any SQL. Run once per environment whose schema already
 * matches the current migrations (e.g. databases that were previously managed
 * via `drizzle-kit push`).
 *
 * After baselining, regular `pnpm db:migrate:run` applies only future
 * migrations.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "..", "drizzle");

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }

  const journalPath = path.join(MIGRATIONS_DIR, "meta", "_journal.json");
  if (!fs.existsSync(journalPath)) {
    console.error(`Journal not found at ${journalPath}`);
    process.exit(1);
  }

  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as Journal;
  if (journal.entries.length === 0) {
    console.log("No migrations to baseline.");
    return;
  }

  const client = postgres(connectionString, { max: 1 });
  try {
    await client.unsafe(`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
    await client.unsafe(`
      CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `);

    const existing = await client<{ hash: string }[]>`
      SELECT hash FROM drizzle.__drizzle_migrations
    `;
    const applied = new Set(existing.map((row) => row.hash));

    let inserted = 0;
    let skipped = 0;

    for (const entry of journal.entries) {
      const sqlPath = path.join(MIGRATIONS_DIR, `${entry.tag}.sql`);
      if (!fs.existsSync(sqlPath)) {
        console.error(`Missing SQL file for ${entry.tag} (expected ${sqlPath})`);
        process.exit(1);
      }
      const sqlContent = fs.readFileSync(sqlPath, "utf8");
      const hash = crypto.createHash("sha256").update(sqlContent).digest("hex");

      if (applied.has(hash)) {
        console.log(`  skip  ${entry.tag}  (already baselined)`);
        skipped++;
        continue;
      }

      await client`
        INSERT INTO drizzle.__drizzle_migrations ("hash", "created_at")
        VALUES (${hash}, ${entry.when})
      `;
      console.log(`  mark  ${entry.tag}  applied=${new Date(entry.when).toISOString()}`);
      inserted++;
    }

    console.log(`\nBaseline complete: ${inserted} marked, ${skipped} already present.`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Baseline failed:", err);
  process.exit(1);
});
