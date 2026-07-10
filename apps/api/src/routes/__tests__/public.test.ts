import { describe, it, expect, beforeEach } from "vitest";
import { db, formSubmissions } from "@cadmus/db";
import { eq } from "drizzle-orm";
import { api, createTestSite, createTestUser, authHeaders } from "../../test/helpers.js";

describe("Public routes", () => {
  let site: any;
  let user: any;
  let headers: Record<string, string>;

  beforeEach(async () => {
    site = await createTestSite();
    user = await createTestUser(site.id);
    headers = await authHeaders(user.id, user.email, user.role, site.id);
  });

  // ---------------------------------------------------------------------------
  // Preview flow (Feature A)
  // ---------------------------------------------------------------------------
  describe("Draft preview flow", () => {
    it("creates a draft, generates preview token, and serves content via preview URL", async () => {
      // 1. Create a draft page
      const createRes = await api("POST", "/api/content", {
        headers,
        body: {
          type: "page",
          slug: "preview-draft-page",
          schemaData: { title: "Draft Page" },
          blocks: [
            { blockType: "heading", data: { text: "Preview Heading" } },
            { blockType: "paragraph", data: { text: "Draft body text" } },
          ],
        },
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      expect(created.status).toBe("draft");

      // 2. Generate a preview token
      const previewRes = await api("POST", `/api/content/${created.id}/preview`, {
        headers,
      });
      expect(previewRes.status).toBe(200);
      const previewData = await previewRes.json();
      expect(previewData.token).toBeTruthy();
      expect(previewData.previewUrl).toBeTruthy();

      // 3. Verify the token returns draft content via public preview endpoint
      const publicPreviewRes = await api("GET", `/api/public/preview/${previewData.token}`, {
        headers: { "x-site-id": site.id },
      });
      expect(publicPreviewRes.status).toBe(200);
      const previewContent = await publicPreviewRes.json();
      expect(previewContent.id).toBe(created.id);
      expect(previewContent.slug).toBe("preview-draft-page");
      expect(previewContent._preview).toBe(true);
      expect(previewContent.blocks).toHaveLength(2);
      expect(previewContent.blocks[0].blockType).toBe("heading");
      expect(previewContent.blocks[1].blockType).toBe("paragraph");
    });

    it("returns 404 for draft content via public slug endpoint", async () => {
      // Create a draft (default status)
      const createRes = await api("POST", "/api/content", {
        headers,
        body: {
          type: "page",
          slug: "invisible-draft",
          schemaData: { title: "Should Not Be Visible" },
        },
      });
      expect(createRes.status).toBe(201);

      // Attempt to fetch by slug on the public endpoint — should 404
      const publicRes = await api("GET", "/api/public/content/invisible-draft", {
        headers: { "x-site-id": site.id },
      });
      expect(publicRes.status).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------
  // Public content flow
  // ---------------------------------------------------------------------------
  describe("Public content endpoints", () => {
    it("returns published content by slug with blocks", async () => {
      // Create content then publish it
      const createRes = await api("POST", "/api/content", {
        headers,
        body: {
          type: "page",
          slug: "about-us",
          schemaData: { title: "About Us" },
          blocks: [
            { blockType: "heading", data: { text: "About" } },
            { blockType: "paragraph", data: { text: "We build things." } },
          ],
        },
      });
      const created = await createRes.json();

      // Publish it
      await api("PUT", `/api/content/${created.id}`, {
        headers,
        body: { status: "published" },
      });

      // Fetch via public slug endpoint
      const publicRes = await api("GET", "/api/public/content/about-us", {
        headers: { "x-site-id": site.id },
      });
      expect(publicRes.status).toBe(200);
      const data = await publicRes.json();
      expect(data.slug).toBe("about-us");
      expect(data.status).toBe("published");
      expect(data.blocks).toHaveLength(2);
      expect(data.blocks[0].blockType).toBe("heading");
      expect(data.blocks[1].blockType).toBe("paragraph");
    });

    it("lists only published content, not drafts", async () => {
      // Create a published page
      const pub = await api("POST", "/api/content", {
        headers,
        body: { type: "page", slug: "published-page" },
      });
      const pubData = await pub.json();
      await api("PUT", `/api/content/${pubData.id}`, {
        headers,
        body: { status: "published" },
      });

      // Create a draft page (should not appear in list)
      await api("POST", "/api/content", {
        headers,
        body: { type: "page", slug: "draft-page" },
      });

      // Fetch the public content list
      const listRes = await api("GET", "/api/public/content", {
        headers: { "x-site-id": site.id },
      });
      expect(listRes.status).toBe(200);
      const listData = await listRes.json();
      expect(listData.items).toHaveLength(1);
      expect(listData.items[0].slug).toBe("published-page");
      expect(listData.items[0].status).toBe("published");
      expect(listData.total).toBe(1);
    });

    it("returns site info including settings via /api/public/site", async () => {
      const res = await api("GET", "/api/public/site", {
        headers: { "x-site-id": site.id },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.id).toBe(site.id);
      expect(data.name).toBe(site.name);
      expect(data.subdomain).toBe(site.subdomain);
      expect(data).toHaveProperty("settings");
    });
  });

  // ---------------------------------------------------------------------------
  // Preview token security
  // ---------------------------------------------------------------------------
  describe("Preview token security", () => {
    it("returns 401 for invalid/garbage token", async () => {
      const res = await api("GET", "/api/public/preview/this-is-garbage", {
        headers: { "x-site-id": site.id },
      });
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toMatch(/invalid|expired/i);
    });

    it("returns 403 when preview token belongs to a different site", async () => {
      // Site A: create content and generate preview token
      const createRes = await api("POST", "/api/content", {
        headers,
        body: {
          type: "page",
          slug: "site-a-page",
          schemaData: { title: "Site A Page" },
        },
      });
      const created = await createRes.json();

      const previewRes = await api("POST", `/api/content/${created.id}/preview`, {
        headers,
      });
      const { token } = await previewRes.json();

      // Site B: different site
      const siteB = await createTestSite();

      // Request preview with Site B's x-site-id — should be 403
      const crossSiteRes = await api("GET", `/api/public/preview/${token}`, {
        headers: { "x-site-id": siteB.id },
      });
      expect(crossSiteRes.status).toBe(403);
      const data = await crossSiteRes.json();
      expect(data.error).toMatch(/does not match/i);
    });
  });

  // ---------------------------------------------------------------------------
  // Form spam protection
  // ---------------------------------------------------------------------------
  describe("Form submission spam protection", () => {
    async function countSubmissions(siteId: string): Promise<number> {
      const rows = await db.select().from(formSubmissions).where(eq(formSubmissions.siteId, siteId));
      return rows.length;
    }

    it("drops submissions that fill the honeypot field", async () => {
      const res = await api("POST", "/api/public/forms/submit", {
        headers: { "x-site-id": site.id },
        body: {
          formIdentifier: "contact",
          fields: { email: "spammer@example.com", message: "buy my stuff" },
          honeypot: "http://spam.example.com",
        },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(await countSubmissions(site.id)).toBe(0);
    });

    it("drops submissions that arrive faster than a human could type", async () => {
      const res = await api("POST", "/api/public/forms/submit", {
        headers: { "x-site-id": site.id },
        body: {
          formIdentifier: "contact",
          fields: { email: "bot@example.com", message: "hi" },
          renderedAt: Date.now(),
        },
      });
      expect(res.status).toBe(200);
      expect(await countSubmissions(site.id)).toBe(0);
    });

    it("accepts legitimate submissions (empty honeypot, realistic timing)", async () => {
      const res = await api("POST", "/api/public/forms/submit", {
        headers: { "x-site-id": site.id },
        body: {
          formIdentifier: "contact",
          fields: { email: "user@example.com", message: "genuine inquiry" },
          honeypot: "",
          renderedAt: Date.now() - 5_000,
        },
      });
      expect(res.status).toBe(200);
      expect(await countSubmissions(site.id)).toBe(1);
    });
  });
});
