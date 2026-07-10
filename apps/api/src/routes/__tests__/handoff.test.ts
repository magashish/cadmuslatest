import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db, users } from "@cadmus/db";
import { signHandoffToken } from "../../lib/handoff.js";
import { api, createTestSite, createTestUser } from "../../test/helpers.js";

describe("Dashboard → admin handoff", () => {
  it("exchanges a cadmus_admin handoff token for a site-scoped session", async () => {
    const site = await createTestSite();
    const adminUser = await createTestUser(site.id, { globalRole: "cadmus_admin" });
    const token = await signHandoffToken(adminUser.id, site.id);

    const res = await api("POST", "/api/auth/handoff", { body: { token } });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.token).toBeTruthy();
    expect(data.user.id).toBe(adminUser.id);
    expect(data.user.siteId).toBe(site.id);
  });

  it("refuses a handoff token for a non-admin user", async () => {
    const site = await createTestSite();
    const normalUser = await createTestUser(site.id); // default globalRole 'user'
    const token = await signHandoffToken(normalUser.id, site.id);

    const res = await api("POST", "/api/auth/handoff", { body: { token } });
    expect(res.status).toBe(403);
  });

  it("rejects a garbage token", async () => {
    const res = await api("POST", "/api/auth/handoff", { body: { token: "not-a-real-token" } });
    expect(res.status).toBe(401);
  });

  it("revokes admin access if the user is demoted after the token is minted", async () => {
    const site = await createTestSite();
    const adminUser = await createTestUser(site.id, { globalRole: "cadmus_admin" });
    const token = await signHandoffToken(adminUser.id, site.id);
    // Demote between mint and exchange.
    await db.update(users).set({ globalRole: "user" }).where(eq(users.id, adminUser.id));

    const res = await api("POST", "/api/auth/handoff", { body: { token } });
    expect(res.status).toBe(403);
  });
});
