import { describe, it, expect } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, users } from "@cadmus/db";
import { api, createTestSite, createTestUser, authHeaders } from "../../test/helpers.js";

describe("Token revocation (tokenVersion)", () => {
  it("accepts a token while its version matches, rejects it after a bump", async () => {
    const site = await createTestSite();
    const user = await createTestUser(site.id);
    const headers = await authHeaders(user.id, user.email, user.role, site.id);

    // Token is valid initially (version 0 matches the user's version 0).
    const before = await api("GET", "/api/content", { headers });
    expect(before.status).toBe(200);

    // Simulate a password reset / forced logout — bump the user's tokenVersion.
    await db
      .update(users)
      .set({ tokenVersion: sql`${users.tokenVersion} + 1` })
      .where(eq(users.id, user.id));

    // The previously-valid token is now stale and rejected.
    const after = await api("GET", "/api/content", { headers });
    expect(after.status).toBe(401);
  });
});
