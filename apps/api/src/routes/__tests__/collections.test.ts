import { describe, it, expect, beforeEach } from "vitest";
import { api, createTestSite, createTestUser, authHeaders } from "../../test/helpers.js";

describe("Collections routes", () => {
  let site: any;
  let user: any;
  let headers: Record<string, string>;

  beforeEach(async () => {
    site = await createTestSite();
    user = await createTestUser(site.id);
    headers = await authHeaders(user.id, user.email, user.role, site.id);
  });

  describe("POST /api/collections", () => {
    it("creates a collection", async () => {
      const res = await api("POST", "/api/collections", {
        headers,
        body: { type: "category", name: "Tech", slug: "tech" },
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.name).toBe("Tech");
      expect(data.slug).toBe("tech");
      expect(data.type).toBe("category");
      expect(data.siteId).toBe(site.id);
    });

    it("returns 400 without required fields", async () => {
      const res = await api("POST", "/api/collections", {
        headers,
        body: { type: "category" },
      });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/collections", () => {
    it("lists collections with type filter", async () => {
      await api("POST", "/api/collections", {
        headers,
        body: { type: "category", name: "Cat", slug: "cat" },
      });
      await api("POST", "/api/collections", {
        headers,
        body: { type: "tag", name: "Tag", slug: "tag" },
      });

      const res = await api("GET", "/api/collections?type=category", { headers });
      const data = await res.json();
      expect(data.items).toHaveLength(1);
      expect(data.items[0].type).toBe("category");
    });
  });

  describe("PUT /api/collections/:id", () => {
    it("updates collection metadata", async () => {
      const createRes = await api("POST", "/api/collections", {
        headers,
        body: { type: "category", name: "Old Name", slug: "old-name" },
      });
      const created = await createRes.json();

      const res = await api("PUT", `/api/collections/${created.id}`, {
        headers,
        body: { name: "New Name", slug: "new-name" },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.name).toBe("New Name");
      expect(data.slug).toBe("new-name");
    });
  });

  describe("DELETE /api/collections/:id", () => {
    it("deletes collection and cleans up associations", async () => {
      const colRes = await api("POST", "/api/collections", {
        headers,
        body: { type: "category", name: "Delete Me", slug: "delete-me" },
      });
      const col = await colRes.json();

      // Create content and associate
      const contentRes = await api("POST", "/api/content", {
        headers,
        body: { type: "page", slug: "assoc-page" },
      });
      const content = await contentRes.json();

      await api("POST", `/api/collections/${col.id}/content`, {
        headers,
        body: { contentId: content.id },
      });

      // Delete collection
      const res = await api("DELETE", `/api/collections/${col.id}`, { headers });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ deleted: true });

      // Verify content associations are gone
      const byContentRes = await api("GET", `/api/collections/by-content/${content.id}`, { headers });
      const byContent = await byContentRes.json();
      expect(byContent.items).toHaveLength(0);
    });
  });

  describe("Content association", () => {
    it("adds and removes content from collection", async () => {
      const colRes = await api("POST", "/api/collections", {
        headers,
        body: { type: "tag", name: "JavaScript", slug: "javascript" },
      });
      const col = await colRes.json();

      const contentRes = await api("POST", "/api/content", {
        headers,
        body: { type: "post", slug: "js-post" },
      });
      const content = await contentRes.json();

      // Add
      const addRes = await api("POST", `/api/collections/${col.id}/content`, {
        headers,
        body: { contentId: content.id },
      });
      expect(addRes.status).toBe(201);

      // Verify association
      const byContentRes = await api("GET", `/api/collections/by-content/${content.id}`, { headers });
      const byContent = await byContentRes.json();
      expect(byContent.items).toHaveLength(1);
      expect(byContent.items[0].name).toBe("JavaScript");

      // Remove
      const removeRes = await api("DELETE", `/api/collections/${col.id}/content/${content.id}`, { headers });
      expect(removeRes.status).toBe(200);

      // Verify removed
      const afterRes = await api("GET", `/api/collections/by-content/${content.id}`, { headers });
      const after = await afterRes.json();
      expect(after.items).toHaveLength(0);
    });
  });
});
