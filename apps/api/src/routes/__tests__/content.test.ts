import { describe, it, expect, beforeEach } from "vitest";
import { db, media } from "@cadmus/db";
import { api, createTestSite, createTestUser, authHeaders } from "../../test/helpers.js";

describe("Content routes", () => {
  let site: any;
  let user: any;
  let headers: Record<string, string>;

  beforeEach(async () => {
    site = await createTestSite();
    user = await createTestUser(site.id);
    headers = await authHeaders(user.id, user.email, user.role, site.id);
  });

  describe("POST /api/content", () => {
    it("creates content with blocks", async () => {
      const res = await api("POST", "/api/content", {
        headers,
        body: {
          type: "page",
          slug: "about-us",
          schemaData: { title: "About Us" },
          blocks: [
            { blockType: "heading", data: { text: "Welcome" } },
            { blockType: "paragraph", data: { text: "Hello world" } },
          ],
        },
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.type).toBe("page");
      expect(data.slug).toBe("about-us");
      expect(data.blocks).toHaveLength(2);
      expect(data.blocks[0].blockType).toBe("heading");
      expect(data.blocks[1].blockType).toBe("paragraph");
    });

    it("returns 400 without required fields", async () => {
      const res = await api("POST", "/api/content", {
        headers,
        body: { type: "page" },
      });
      expect(res.status).toBe(400);
    });

    it("creates a version on creation", async () => {
      const createRes = await api("POST", "/api/content", {
        headers,
        body: { type: "post", slug: "first-post" },
      });
      const created = await createRes.json();

      const versionsRes = await api("GET", `/api/content/${created.id}/versions`, { headers });
      const { versions } = await versionsRes.json();
      expect(versions).toHaveLength(1);
      expect(versions[0].version).toBe(1);
    });
  });

  describe("GET /api/content", () => {
    it("lists content filtered by type", async () => {
      await api("POST", "/api/content", {
        headers,
        body: { type: "page", slug: "page-1" },
      });
      await api("POST", "/api/content", {
        headers,
        body: { type: "post", slug: "post-1" },
      });

      const res = await api("GET", "/api/content?type=page", { headers });
      const data = await res.json();
      expect(data.items).toHaveLength(1);
      expect(data.items[0].type).toBe("page");
      expect(data.total).toBe(1);
    });
  });

  describe("GET /api/content/:id", () => {
    it("returns content with blocks", async () => {
      const createRes = await api("POST", "/api/content", {
        headers,
        body: {
          type: "page",
          slug: "detail-test",
          blocks: [{ blockType: "text", data: { content: "hi" } }],
        },
      });
      const created = await createRes.json();

      const res = await api("GET", `/api/content/${created.id}`, { headers });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.id).toBe(created.id);
      expect(data.blocks).toHaveLength(1);
    });

    it("returns 404 for unknown id", async () => {
      const res = await api("GET", "/api/content/00000000-0000-0000-0000-000000000000", { headers });
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /api/content/:id", () => {
    it("updates content and creates new version", async () => {
      const createRes = await api("POST", "/api/content", {
        headers,
        body: { type: "page", slug: "update-me" },
      });
      const created = await createRes.json();

      const res = await api("PUT", `/api/content/${created.id}`, {
        headers,
        body: { slug: "updated-slug", status: "published" },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.slug).toBe("updated-slug");
      expect(data.status).toBe("published");
      expect(data.publishedAt).toBeTruthy();

      // Should now have 2 versions
      const versionsRes = await api("GET", `/api/content/${created.id}/versions`, { headers });
      const { versions } = await versionsRes.json();
      expect(versions).toHaveLength(2);
    });

    it("replaces blocks on update", async () => {
      const createRes = await api("POST", "/api/content", {
        headers,
        body: {
          type: "page",
          slug: "blocks-update",
          blocks: [{ blockType: "heading", data: { text: "Old" } }],
        },
      });
      const created = await createRes.json();

      const res = await api("PUT", `/api/content/${created.id}`, {
        headers,
        body: {
          blocks: [
            { blockType: "paragraph", data: { text: "New 1" } },
            { blockType: "paragraph", data: { text: "New 2" } },
          ],
        },
      });
      const data = await res.json();
      expect(data.blocks).toHaveLength(2);
      expect(data.blocks[0].blockType).toBe("paragraph");
    });
  });

  describe("DELETE /api/content/:id", () => {
    it("soft-deletes (archives) content", async () => {
      const createRes = await api("POST", "/api/content", {
        headers,
        body: { type: "page", slug: "delete-me" },
      });
      const created = await createRes.json();

      const res = await api("DELETE", `/api/content/${created.id}`, { headers });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe("archived");
    });
  });

  describe("POST /api/content/:id/versions/:version/restore", () => {
    it("restores a previous version", async () => {
      const createRes = await api("POST", "/api/content", {
        headers,
        body: {
          type: "page",
          slug: "restore-test",
          schemaData: { title: "V1" },
          blocks: [{ blockType: "text", data: { content: "v1" } }],
        },
      });
      const created = await createRes.json();

      // Update to V2
      await api("PUT", `/api/content/${created.id}`, {
        headers,
        body: {
          schemaData: { title: "V2" },
          blocks: [{ blockType: "text", data: { content: "v2" } }],
        },
      });

      // Restore V1
      const res = await api("POST", `/api/content/${created.id}/versions/1/restore`, {
        headers,
        body: {},
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.schemaData).toEqual({ title: "V1" });
      expect(data.blocks).toHaveLength(1);
      expect(data.blocks[0].blockType).toBe("text");
    });

    it("returns 404 for unknown version", async () => {
      const createRes = await api("POST", "/api/content", {
        headers,
        body: { type: "page", slug: "no-version" },
      });
      const created = await createRes.json();

      const res = await api("POST", `/api/content/${created.id}/versions/999/restore`, {
        headers,
        body: {},
      });
      expect(res.status).toBe(404);
    });
  });

  describe("Media attach/detach", () => {
    it("attaches and detaches media from content", async () => {
      // Create content
      const contentRes = await api("POST", "/api/content", {
        headers,
        body: { type: "page", slug: "media-test" },
      });
      const created = await contentRes.json();

      // Create a media record directly in DB
      const [mediaItem] = await db
        .insert(media)
        .values({
          siteId: site.id,
          filename: "test.jpg",
          storageUrl: "https://example.com/test.jpg",
          mimeType: "image/jpeg",
        })
        .returning();

      // Attach
      const attachRes = await api("POST", `/api/content/${created.id}/media`, {
        headers,
        body: { mediaId: mediaItem.id, context: "hero" },
      });
      expect(attachRes.status).toBe(201);

      // Detach
      const detachRes = await api("DELETE", `/api/content/${created.id}/media/${mediaItem.id}`, {
        headers,
      });
      expect(detachRes.status).toBe(200);
      expect(await detachRes.json()).toEqual({ deleted: true });
    });
  });
});
