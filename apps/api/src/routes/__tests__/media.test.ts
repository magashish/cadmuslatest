import { describe, it, expect, beforeEach } from "vitest";
import { db, media } from "@cadmus/db";
import { api, createTestSite, createTestUser, authHeaders } from "../../test/helpers.js";

describe("Media routes", () => {
  let site: any;
  let user: any;
  let headers: Record<string, string>;

  beforeEach(async () => {
    site = await createTestSite();
    user = await createTestUser(site.id);
    headers = await authHeaders(user.id, user.email, user.role, site.id);
  });

  async function insertMedia(overrides: Record<string, unknown> = {}) {
    const [item] = await db
      .insert(media)
      .values({
        siteId: site.id,
        filename: "photo.jpg",
        storageUrl: "https://storage.example.com/photo.jpg",
        mimeType: "image/jpeg",
        ...overrides,
      })
      .returning();
    return item;
  }

  describe("GET /api/media", () => {
    it("lists media for the site", async () => {
      await insertMedia({ filename: "a.jpg" });
      await insertMedia({ filename: "b.png", mimeType: "image/png" });

      const res = await api("GET", "/api/media", { headers });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.items).toHaveLength(2);
      expect(data.total).toBe(2);
    });

    it("filters by mime type prefix", async () => {
      await insertMedia({ filename: "doc.pdf", mimeType: "application/pdf" });
      await insertMedia({ filename: "img.jpg", mimeType: "image/jpeg" });

      const res = await api("GET", "/api/media?mime=image", { headers });
      const data = await res.json();
      expect(data.items).toHaveLength(1);
      expect(data.items[0].filename).toBe("img.jpg");
    });
  });

  describe("GET /api/media/:id", () => {
    it("returns a single media item", async () => {
      const item = await insertMedia();
      const res = await api("GET", `/api/media/${item.id}`, { headers });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.id).toBe(item.id);
      expect(data.filename).toBe("photo.jpg");
    });

    it("returns 404 for unknown id", async () => {
      const res = await api("GET", "/api/media/00000000-0000-0000-0000-000000000000", { headers });
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /api/media/:id", () => {
    it("updates metadata", async () => {
      const item = await insertMedia();

      const res = await api("PUT", `/api/media/${item.id}`, {
        headers,
        body: {
          aiAltText: "A scenic mountain view",
          aiTags: ["nature", "landscape"],
          filename: "mountain.jpg",
        },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.aiAltText).toBe("A scenic mountain view");
      expect(data.aiTags).toEqual(["nature", "landscape"]);
      expect(data.filename).toBe("mountain.jpg");
    });
  });

  describe("DELETE /api/media/:id", () => {
    it("deletes media record (no storage provider in tests)", async () => {
      const item = await insertMedia();

      const res = await api("DELETE", `/api/media/${item.id}`, { headers });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ deleted: true });

      // Verify gone
      const getRes = await api("GET", `/api/media/${item.id}`, { headers });
      expect(getRes.status).toBe(404);
    });
  });
});
