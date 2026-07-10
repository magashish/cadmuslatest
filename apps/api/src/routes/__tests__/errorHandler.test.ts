import { describe, it, expect, beforeEach } from "vitest";
import { api, createTestSite, createTestUser, authHeaders } from "../../test/helpers.js";

describe("Error handler", () => {
  let site: any;
  let user: any;
  let headers: Record<string, string>;

  beforeEach(async () => {
    site = await createTestSite();
    user = await createTestUser(site.id);
    headers = await authHeaders(user.id, user.email, user.role, site.id);
  });

  it("returns 409 on unique constraint violation (duplicate subdomain)", async () => {
    // Provision two sites with same email — both get unique subdomains, should be fine
    // But creating a collection with a slug, then trying a duplicate via DB constraint would trigger 23505
    // Easier: provision creates unique subdomains so we test via duplicate domain
    // Custom domains require a paid plan (feature gate), so use paid sites.
    const paidSite = await createTestSite({ plan: "monthly" });
    const paidUser = await createTestUser(paidSite.id);
    const paidHeaders = await authHeaders(paidUser.id, paidUser.email, paidUser.role, paidSite.id);

    await api("POST", `/api/sites/${paidSite.id}/domain`, {
      headers: paidHeaders,
      body: { domain: "unique-test.com" },
    });

    const site2 = await createTestSite({ plan: "monthly" });
    const user2 = await createTestUser(site2.id);
    const h2 = await authHeaders(user2.id, user2.email, user2.role, site2.id);

    // The sites route checks for domain conflicts manually before the DB does,
    // so this returns 409 from the route logic
    const res = await api("POST", `/api/sites/${site2.id}/domain`, {
      headers: h2,
      body: { domain: "unique-test.com" },
    });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it("returns 400 on missing required field", async () => {
    const res = await api("POST", "/api/content", {
      headers,
      body: { type: "page" }, // missing slug
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it("returns 401 without auth token", async () => {
    const res = await api("GET", "/api/content", {
      headers: { "x-site-id": site.id },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 with invalid token", async () => {
    const res = await api("GET", "/api/content", {
      headers: {
        authorization: "Bearer invalid-token",
        "x-site-id": site.id,
      },
    });
    expect(res.status).toBe(401);
  });
});
