import { describe, it, expect } from "vitest";
import { db, content, media } from "@cadmus/db";
import { api, createTestSite, createTestUser, authHeaders } from "../../test/helpers.js";

describe("Cross-tenant isolation", () => {
  it("won't attach another site's media to your content", async () => {
    const siteA = await createTestSite();
    const userA = await createTestUser(siteA.id);
    const headersA = await authHeaders(userA.id, userA.email, userA.role, siteA.id);
    const [pageA] = await db
      .insert(content)
      .values({ siteId: siteA.id, type: "page", slug: "page-a", status: "draft" })
      .returning();

    // Media that belongs to a DIFFERENT site.
    const siteB = await createTestSite();
    const [mediaB] = await db
      .insert(media)
      .values({ siteId: siteB.id, filename: "b.png", storageUrl: "https://x/b.png" })
      .returning();

    const cross = await api("POST", `/api/content/${pageA.id}/media`, {
      headers: headersA,
      body: { mediaId: mediaB.id },
    });
    expect(cross.status).toBe(404);

    // Same-site media attaches fine.
    const [mediaA] = await db
      .insert(media)
      .values({ siteId: siteA.id, filename: "a.png", storageUrl: "https://x/a.png" })
      .returning();
    const ok = await api("POST", `/api/content/${pageA.id}/media`, {
      headers: headersA,
      body: { mediaId: mediaA.id },
    });
    expect(ok.status).toBe(201);
  });
});
