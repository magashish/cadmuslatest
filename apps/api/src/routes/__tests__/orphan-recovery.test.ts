import { describe, it, expect } from "vitest";
import { eq, and } from "drizzle-orm";
import { db, users, siteMembers, sites } from "@cadmus/db";
import { hardDeleteSite } from "../admin.js";
import { api, createTestSite, createTestUser } from "../../test/helpers.js";

const PASSWORD = "SuperSecret123";

describe("Orphaned-user recovery (re-point + reclaim)", () => {
  // ── hardDeleteSite re-points the default site ─────────────────────────────
  it("re-points a multi-site user to a surviving site and orphans a single-site user", async () => {
    const siteA = await createTestSite();
    const siteB = await createTestSite();

    // userMulti: default = siteA, but also an active member of siteB.
    const userMulti = await createTestUser(siteA.id);
    await db.insert(siteMembers).values({
      siteId: siteB.id,
      userId: userMulti.id,
      role: "owner",
      status: "active",
    });

    // userSolo: only on siteA.
    const userSolo = await createTestUser(siteA.id);

    await hardDeleteSite(siteA.id);

    const [multiAfter] = await db.select().from(users).where(eq(users.id, userMulti.id));
    const [soloAfter] = await db.select().from(users).where(eq(users.id, userSolo.id));
    const [siteAfter] = await db.select().from(sites).where(eq(sites.id, siteA.id));

    expect(siteAfter).toBeUndefined(); // site gone
    expect(multiAfter.siteId).toBe(siteB.id); // re-pointed, not nulled
    expect(soloAfter.siteId).toBeNull(); // truly orphaned
    // Both user rows survive (recoverable).
    expect(multiAfter).toBeTruthy();
    expect(soloAfter).toBeTruthy();
  });

  // ── signup reclaims an orphaned account ───────────────────────────────────
  it("lets an orphaned account reclaim itself by signing up again", async () => {
    // Orphan: a plain user with no active memberships and a known referral code.
    const [orphan] = await db
      .insert(users)
      .values({
        email: `orphan-${Date.now()}@example.com`,
        role: "owner",
        globalRole: "user",
        referralCode: `ref-keep-${Date.now()}`,
      })
      .returning();

    const res = await api("POST", "/api/auth/signup", {
      body: { name: "Fresh Start", email: orphan.email, password: PASSWORD },
    });
    expect(res.status).toBe(201);
    const data = await res.json();

    // Same account reused (identity preserved), now attached to a new site.
    expect(data.user.id).toBe(orphan.id);
    const [after] = await db.select().from(users).where(eq(users.id, orphan.id));
    expect(after.referralCode).toBe(orphan.referralCode); // referral identity kept
    expect(after.siteId).toBeTruthy();
    expect(after.emailVerifiedAt).toBeNull(); // must re-verify

    const [membership] = await db
      .select()
      .from(siteMembers)
      .where(and(eq(siteMembers.userId, orphan.id), eq(siteMembers.status, "active")));
    expect(membership).toBeTruthy();
  });

  it("still blocks signup for an account with an active site (not orphaned)", async () => {
    const site = await createTestSite();
    const active = await createTestUser(site.id); // createTestUser adds an active membership

    const res = await api("POST", "/api/auth/signup", {
      body: { name: "Dup", email: active.email, password: PASSWORD },
    });
    expect(res.status).toBe(409);
  });

  it("does not let signup hijack a partner account, even when orphaned", async () => {
    const [partnerOrphan] = await db
      .insert(users)
      .values({
        email: `partner-orphan-${Date.now()}@example.com`,
        role: "owner",
        globalRole: "partner",
      })
      .returning();

    const res = await api("POST", "/api/auth/signup", {
      body: { name: "Hijack", email: partnerOrphan.email, password: PASSWORD },
    });
    expect(res.status).toBe(409);
  });
});
