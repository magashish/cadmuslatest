import { describe, it, expect, beforeEach } from "vitest";
import { api, createTestSite, createTestUser, authHeaders } from "../../test/helpers.js";

describe("Sites routes", () => {
  let site: any;
  let user: any;
  let headers: Record<string, string>;

  beforeEach(async () => {
    site = await createTestSite();
    user = await createTestUser(site.id);
    headers = await authHeaders(user.id, user.email, user.role, site.id);
  });

  describe("POST /api/sites (provision)", () => {
    it("creates a new site with owner", async () => {
      const res = await api("POST", "/api/sites", {
        body: { name: "My New Site", ownerEmail: "owner@example.com" },
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.site.name).toBe("My New Site");
      expect(data.site.status).toBe("onboarding");
      expect(data.site.subdomain).toMatch(/^site-/);
      expect(data.owner.email).toBe("owner@example.com");
      expect(data.owner.role).toBe("owner");
      // Admin is served from the canonical base domain, not per-site subdomains
      expect(data.adminUrl).toMatch(/^https:\/\/[^/]+\/admin$/);
    });

    it("returns 400 without required fields", async () => {
      const res = await api("POST", "/api/sites", { body: { name: "No email" } });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/sites/:id", () => {
    it("returns site by id", async () => {
      const res = await api("GET", `/api/sites/${site.id}`, { headers });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.id).toBe(site.id);
      expect(data.name).toBe(site.name);
    });

    it("returns 403 for a site the user is not a member of", async () => {
      // Non-members get 403 (not 404) so site ids can't be enumerated.
      const res = await api("GET", "/api/sites/00000000-0000-0000-0000-000000000000", { headers });
      expect(res.status).toBe(403);
    });
  });

  describe("PUT /api/sites/:id", () => {
    it("updates site fields", async () => {
      const res = await api("PUT", `/api/sites/${site.id}`, {
        headers,
        body: { name: "Updated Name", settings: { businessInfo: { tagline: "Hello" } } },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.name).toBe("Updated Name");
      expect(data.settings).toEqual({ businessInfo: { tagline: "Hello" } });
    });
  });

  describe("POST /api/sites/:id/activate", () => {
    it("transitions onboarding site to active", async () => {
      const onboarding = await createTestSite({ status: "onboarding" });
      const onboardingUser = await createTestUser(onboarding.id);
      const h = await authHeaders(onboardingUser.id, onboardingUser.email, onboardingUser.role, onboarding.id);

      const res = await api("POST", `/api/sites/${onboarding.id}/activate`, {
        headers: h,
        body: {},
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe("active");
    });

    it("rejects activation of already-active site", async () => {
      const res = await api("POST", `/api/sites/${site.id}/activate`, {
        headers,
        body: {},
      });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/sites/:id/domain", () => {
    // Custom domains require a paid plan (feature gate), so these use paid sites.
    it("connects a custom domain", async () => {
      const paidSite = await createTestSite({ plan: "monthly" });
      const paidUser = await createTestUser(paidSite.id);
      const paidHeaders = await authHeaders(paidUser.id, paidUser.email, paidUser.role, paidSite.id);

      const res = await api("POST", `/api/sites/${paidSite.id}/domain`, {
        headers: paidHeaders,
        body: { domain: "example.com" },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.site.domain).toBe("example.com");
      expect(data.isRootDomain).toBe(true);
      expect(data.dns.instructions).toHaveLength(1);
      expect(data.dns.instructions[0]).toMatchObject({
        type: "CNAME",
        name: "www",
        value: "origin.cadmus.digital",
      });
    });

    it("rejects duplicate domain", async () => {
      const paidSite = await createTestSite({ plan: "monthly" });
      const paidUser = await createTestUser(paidSite.id);
      const paidHeaders = await authHeaders(paidUser.id, paidUser.email, paidUser.role, paidSite.id);

      await api("POST", `/api/sites/${paidSite.id}/domain`, {
        headers: paidHeaders,
        body: { domain: "taken.com" },
      });

      const site2 = await createTestSite({ plan: "monthly" });
      const user2 = await createTestUser(site2.id);
      const h2 = await authHeaders(user2.id, user2.email, user2.role, site2.id);

      const res = await api("POST", `/api/sites/${site2.id}/domain`, {
        headers: h2,
        body: { domain: "taken.com" },
      });
      expect(res.status).toBe(409);
    });
  });

  describe("GET /api/sites/:id/stats", () => {
    it("returns site stats", async () => {
      const res = await api("GET", `/api/sites/${site.id}/stats`, { headers });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveProperty("content");
      expect(data).toHaveProperty("media");
      expect(data).toHaveProperty("activity");
    });
  });
});
