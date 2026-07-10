// Writes public/version.json for an SPA build so the platform Monitoring
// page can read git SHA + build timestamp at runtime.
// Reads GITHUB_SHA (set automatically by GitHub Actions) so this works
// whether the deploy workflow passes anything explicitly or not.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const out = resolve(process.cwd(), "public/version.json");
const sha = (process.env.GITHUB_SHA || process.env.GIT_SHA || "").slice(0, 7) || null;
const builtAt = new Date().toISOString();

mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  JSON.stringify({ gitSha: sha, builtAt }, null, 2) + "\n",
);
console.log(`Wrote ${out}: gitSha=${sha} builtAt=${builtAt}`);
