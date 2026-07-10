import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db } from "@cadmus/db";
import { getStorageProvider } from "./media.js";

export const healthRoutes = new Hono();

// Liveness — "is the process alive?" No dependency checks.
healthRoutes.get("/", (c) => c.json({ status: "ok" }));

type CheckStatus = "ok" | "fail" | "skipped";
interface ReadinessResult {
  status: "ok" | "fail";
  checks: { db: CheckStatus; storage: CheckStatus };
  error?: string;
  checkedAt: number;
}

let cached: ReadinessResult | null = null;
const CACHE_MS = 5_000;

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms),
    ),
  ]);
}

async function runChecks(): Promise<ReadinessResult> {
  const checks: ReadinessResult["checks"] = { db: "fail", storage: "skipped" };
  const errors: string[] = [];

  try {
    await withTimeout(db.execute(sql`SELECT 1`), 2_000, "db");
    checks.db = "ok";
  } catch (err) {
    errors.push(`db: ${(err as Error).message}`);
  }

  const storage = getStorageProvider();
  if (storage) {
    try {
      await withTimeout(storage.ping(), 2_000, "storage");
      checks.storage = "ok";
    } catch (err) {
      checks.storage = "fail";
      errors.push(`storage: ${(err as Error).message}`);
    }
  }

  const failed = checks.db === "fail" || checks.storage === "fail";
  return {
    status: failed ? "fail" : "ok",
    checks,
    ...(errors.length ? { error: errors.join("; ") } : {}),
    checkedAt: Date.now(),
  };
}

// Readiness — "can this instance serve traffic?" Checks critical deps.
// Cached briefly so frequent probes don't hammer downstream services.
healthRoutes.get("/ready", async (c) => {
  if (cached && Date.now() - cached.checkedAt < CACHE_MS) {
    return c.json(cached, cached.status === "ok" ? 200 : 503);
  }
  cached = await runChecks();
  return c.json(cached, cached.status === "ok" ? 200 : 503);
});
