#!/usr/bin/env node
// Validates that every entry in the Drizzle migration journal has a `when`
// timestamp strictly greater than the previous entry. A mis-ordered timestamp
// causes drizzle-orm's migrate() to silently skip the migration.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const journalPath = resolve(__dirname, "../drizzle/meta/_journal.json");

const journal = JSON.parse(readFileSync(journalPath, "utf-8"));
const entries = journal.entries;

let failed = false;

for (let i = 1; i < entries.length; i++) {
  const prev = entries[i - 1];
  const curr = entries[i];
  if (curr.when <= prev.when) {
    console.error(
      `Journal ordering error: entry ${curr.idx} ("${curr.tag}", when=${curr.when}) ` +
        `must be > entry ${prev.idx} ("${prev.tag}", when=${prev.when})`
    );
    failed = true;
  }
}

if (failed) {
  console.error(
    "\nFix: run `pnpm db:generate --name <tag>` to produce the journal entry " +
      "instead of writing it by hand."
  );
  process.exit(1);
}

console.log(`Journal OK — ${entries.length} entries in order.`);
