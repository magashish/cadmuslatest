import { describe, it, expect, beforeEach } from "vitest";
import { api, createTestSite, createTestUser, authHeaders } from "../../test/helpers.js";

describe("Navigation routes", () => {
  let site: any;
  let user: any;
  let headers: Record<string, string>;

  beforeEach(async () => {
    site = await createTestSite();
    user = await createTestUser(site.id);
    headers = await authHeaders(user.id, user.email, user.role, site.id);
  });

  describe("PUT /api/navigation/:location (upsert)", () => {
    it("creates navigation for a new location", async () => {
      const res = await api("PUT", "/api/navigation/header", {
        headers,
        body: {
          items: [
            { label: "Home", url: "/" },
            { label: "About", url: "/about" },
          ],
        },
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.location).toBe("header");
      expect(data.items).toHaveLength(2);
    });

    it("updates existing navigation for same location", async () => {
      await api("PUT", "/api/navigation/footer", {
        headers,
        body: { items: [{ label: "Old", url: "/old" }] },
      });

      const res = await api("PUT", "/api/navigation/footer", {
        headers,
        body: { items: [{ label: "New", url: "/new" }] },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.items).toHaveLength(1);
      expect(data.items[0].label).toBe("New");
    });
  });

  describe("GET /api/navigation", () => {
    it("lists navigation records", async () => {
      await api("PUT", "/api/navigation/header", {
        headers,
        body: { items: [{ label: "Home", url: "/" }] },
      });
      await api("PUT", "/api/navigation/footer", {
        headers,
        body: { items: [{ label: "Privacy", url: "/privacy" }] },
      });

      const res = await api("GET", "/api/navigation", { headers });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.items).toHaveLength(2);
    });

    it("filters by location", async () => {
      await api("PUT", "/api/navigation/header", {
        headers,
        body: { items: [{ label: "Home", url: "/" }] },
      });
      await api("PUT", "/api/navigation/footer", {
        headers,
        body: { items: [{ label: "Privacy", url: "/privacy" }] },
      });

      const res = await api("GET", "/api/navigation?location=header", { headers });
      const data = await res.json();
      expect(data.items).toHaveLength(1);
      expect(data.items[0].location).toBe("header");
    });
  });

  describe("GET /api/navigation/:id", () => {
    it("returns a single navigation record", async () => {
      const createRes = await api("PUT", "/api/navigation/sidebar", {
        headers,
        body: { items: [{ label: "Links", url: "/links" }] },
      });
      const created = await createRes.json();

      const res = await api("GET", `/api/navigation/${created.id}`, { headers });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.id).toBe(created.id);
      expect(data.location).toBe("sidebar");
    });

    it("returns 404 for unknown id", async () => {
      const res = await api("GET", "/api/navigation/00000000-0000-0000-0000-000000000000", { headers });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/navigation/:id", () => {
    it("deletes a navigation record", async () => {
      const createRes = await api("PUT", "/api/navigation/header", {
        headers,
        body: { items: [{ label: "Home", url: "/" }] },
      });
      const created = await createRes.json();

      const res = await api("DELETE", `/api/navigation/${created.id}`, { headers });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ deleted: true });

      // Verify gone
      const getRes = await api("GET", `/api/navigation/${created.id}`, { headers });
      expect(getRes.status).toBe(404);
    });
  });
});
