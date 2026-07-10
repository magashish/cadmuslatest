import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db, users, partners, referrals } from "@cadmus/db";
import { api, createTestSite, createTestUser } from "../../test/helpers.js";

const PASSWORD = "SuperSecret123";

async function signup(email: string, referralCode?: string) {
  return api("POST", "/api/auth/signup", {
    body: { name: "Referred Co", email, password: PASSWORD, ...(referralCode ? { referralCode } : {}) },
  });
}

async function referralForEmail(email: string) {
  const [owner] = await db.select().from(users).where(eq(users.email, email));
  if (!owner) return null;
  const [ref] = await db.select().from(referrals).where(eq(referrals.referredSiteId, owner.siteId));
  return ref ?? null;
}

describe("Referral attribution at signup", () => {
  it("attributes a signup to a partner via the partner code (case-insensitive)", async () => {
    const site = await createTestSite();
    const partnerUser = await createTestUser(site.id, { globalRole: "partner" });
    await db.insert(partners).values({
      userId: partnerUser.id,
      name: "Acme Web",
      code: "ACME2026",
      status: "active",
    });

    const email = `partner-ref-${Date.now()}@example.com`;
    const res = await signup(email, "acme2026"); // lowercase in link still resolves
    expect(res.status).toBe(201);

    const ref = await referralForEmail(email);
    expect(ref).toBeTruthy();
    expect(ref!.referrerUserId).toBe(partnerUser.id);
    expect(ref!.referralCode).toBe("ACME2026");
    expect(ref!.status).toBe("pending");
  });

  it("falls back to a personal user referral code", async () => {
    const site = await createTestSite();
    const referrer = await createTestUser(site.id, { referralCode: "ref-abc123" });

    const email = `user-ref-${Date.now()}@example.com`;
    const res = await signup(email, "ref-abc123");
    expect(res.status).toBe(201);

    const ref = await referralForEmail(email);
    expect(ref).toBeTruthy();
    expect(ref!.referrerUserId).toBe(referrer.id);
    expect(ref!.referralCode).toBe("ref-abc123");
  });

  it("ignores an invalid code without blocking signup", async () => {
    const email = `bad-ref-${Date.now()}@example.com`;
    const res = await signup(email, "NOT_A_REAL_CODE");
    expect(res.status).toBe(201);
    expect(await referralForEmail(email)).toBeNull();
  });

  it("records no referral when no code is supplied", async () => {
    const email = `no-ref-${Date.now()}@example.com`;
    const res = await signup(email);
    expect(res.status).toBe(201);
    expect(await referralForEmail(email)).toBeNull();
  });
});
