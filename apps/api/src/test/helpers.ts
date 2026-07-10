import { db, sites, users, siteMembers } from "@cadmus/db";
import { signToken } from "../middleware/auth.js";
import { app } from "../app.js";

// ---------------------------------------------------------------------------
// Test data factories
// ---------------------------------------------------------------------------

let siteCounter = 0;

export async function createTestSite(overrides: Record<string, unknown> = {}) {
  siteCounter++;
  const [site] = await db
    .insert(sites)
    .values({
      name: `Test Site ${siteCounter}`,
      subdomain: `test-site-${siteCounter}-${Date.now()}`,
      status: "active",
      ...overrides,
    })
    .returning();
  return site;
}

export async function createTestUser(
  siteId: string,
  overrides: Record<string, unknown> = {},
) {
  const [user] = await db
    .insert(users)
    .values({
      siteId,
      email: `test-${Date.now()}@example.com`,
      role: "owner",
      ...overrides,
    })
    .returning();
  // Mirror production: a user of a site has an active site_members row. The
  // requireSiteMembership middleware authorizes requests against this, so tests
  // must create it or every authenticated tenant request would 403.
  await db.insert(siteMembers).values({
    siteId,
    userId: user.id,
    role: user.role,
    status: "active",
  });
  return user;
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

export async function authHeaders(userId: string, email: string, role: string, siteId: string) {
  const token = await signToken({ id: userId, email, role, siteId });
  return {
    authorization: `Bearer ${token}`,
    "x-site-id": siteId,
  };
}

// ---------------------------------------------------------------------------
// Request helper
// ---------------------------------------------------------------------------

export async function api(
  method: string,
  path: string,
  opts?: {
    body?: unknown;
    headers?: Record<string, string>;
  },
) {
  return app.request(path, {
    method,
    headers: {
      "content-type": "application/json",
      ...opts?.headers,
    },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
}
