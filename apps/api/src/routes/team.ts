import crypto from "node:crypto";
import { Hono } from "hono";
import { eq, and, count } from "drizzle-orm";
import { db, users, sites, siteMembers, subscriptions, auditLog } from "@cadmus/db";
import { requireRole } from "../middleware/auth.js";
import { checkFeatureGate } from "../lib/feature-gates.js";
import { z } from "zod";
import { hashPassword, meetsPasswordRequirements } from "../lib/password.js";
import { hashToken } from "../lib/tokens.js";
import { readValidatedJson } from "../lib/validate.js";
import { getEmailProvider } from "../lib/email.js";
import type { AuthUser, SiteRole } from "@cadmus/shared";

export const teamRoutes = new Hono<{ Variables: { user: AuthUser } }>();

// Owner can be neither invited nor assigned via this route.
const inviteSchema = z.object({
  email: z.string().trim().email().max(255),
  role: z.enum(["admin", "editor", "viewer"]).default("editor"),
});

// ── GET / — list site members ───────────────────────────────────────────────

teamRoutes.get("/", async (c) => {
  const user = c.get("user") as AuthUser;
  const siteId = user.siteId;

  const members = await db
    .select({
      id: siteMembers.id,
      userId: siteMembers.userId,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      role: siteMembers.role,
      status: siteMembers.status,
      invitedAt: siteMembers.invitedAt,
      joinedAt: siteMembers.joinedAt,
    })
    .from(siteMembers)
    .innerJoin(users, eq(users.id, siteMembers.userId))
    .where(and(eq(siteMembers.siteId, siteId), eq(siteMembers.status, "active")));

  // Also include pending invites
  const invited = await db
    .select({
      id: siteMembers.id,
      userId: siteMembers.userId,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      role: siteMembers.role,
      status: siteMembers.status,
      invitedAt: siteMembers.invitedAt,
      joinedAt: siteMembers.joinedAt,
    })
    .from(siteMembers)
    .innerJoin(users, eq(users.id, siteMembers.userId))
    .where(and(eq(siteMembers.siteId, siteId), eq(siteMembers.status, "invited")));

  return c.json({ members: [...members, ...invited] });
});

// ── POST /invite — invite a user to the site ───────────────────────────────

teamRoutes.post("/invite", requireRole("owner", "admin"), async (c) => {
  const authUser = c.get("user") as AuthUser;
  const siteId = authUser.siteId;
  const { email, role } = await readValidatedJson(c, inviteSchema);

  // Check if the user being invited would have a higher role than the inviter
  if (role === "admin" && authUser.role !== "owner") {
    return c.json({ error: "Only owners can invite admins" }, 403);
  }

  // Feature gate: free-tier team member limit
  const [memberCountRow] = await db
    .select({ count: count() })
    .from(siteMembers)
    .where(and(eq(siteMembers.siteId, siteId), eq(siteMembers.status, "active")));
  const currentTeamCount = Number(memberCountRow?.count ?? 0);
  const teamGate = await checkFeatureGate(siteId, "team_members", { currentTeamCount });
  if (!teamGate.allowed) {
    return c.json(
      { error: teamGate.reason || "Team member limit reached for free plan", gate: teamGate },
      403,
    );
  }

  // Get or create the user
  let targetUser: typeof users.$inferSelect;
  let member: typeof siteMembers.$inferSelect;
  let isReinvite = false;
  const [existingUser] = await db.select().from(users).where(eq(users.email, email));

  if (existingUser) {
    targetUser = existingUser;

    const [existingMember] = await db
      .select()
      .from(siteMembers)
      .where(and(eq(siteMembers.userId, existingUser.id), eq(siteMembers.siteId, siteId)));

    if (existingMember && existingMember.status === "active") {
      return c.json({ error: "This user is already a member of this site" }, 409);
    }

    if (existingMember && existingMember.status === "invited") {
      return c.json({ error: "This user has already been invited" }, 409);
    }

    if (existingMember && existingMember.status === "removed") {
      // Reactivate the removed membership — a fresh token + email is sent below
      const [updated] = await db
        .update(siteMembers)
        .set({ role, status: "invited", invitedBy: authUser.id, invitedAt: new Date(), joinedAt: null })
        .where(eq(siteMembers.id, existingMember.id))
        .returning();
      member = updated;
      isReinvite = true;
    } else {
      const [created] = await db
        .insert(siteMembers)
        .values({ siteId, userId: targetUser.id, role, invitedBy: authUser.id, status: "invited" })
        .returning();
      member = created;
    }
  } else {
    // Create placeholder user (no password — they'll set it when accepting)
    const [newUser] = await db
      .insert(users)
      .values({ email, role: "editor" })
      .returning();
    targetUser = newUser;
    const [created] = await db
      .insert(siteMembers)
      .values({ siteId, userId: targetUser.id, role, invitedBy: authUser.id, status: "invited" })
      .returning();
    member = created;
  }

  // Store a fresh invite token, HASHED, in its own column (separate from the
  // password-reset token so an invite link can't double as a reset link). Only
  // the raw token goes out in the email.
  const inviteToken = crypto.randomBytes(32).toString("hex");
  await db
    .update(users)
    .set({
      inviteTokenHash: hashToken(inviteToken),
      inviteTokenExpiry: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    })
    .where(eq(users.id, targetUser.id));

  await db.insert(auditLog).values({
    siteId,
    actorType: "user",
    actorId: authUser.id,
    action: "team.invited",
    entityType: "user",
    entityId: targetUser.id,
    details: { email, role, ...(isReinvite ? { reinvite: true } : {}) },
  });

  // Send invite email
  const emailProvider = getEmailProvider();
  if (emailProvider) {
    const [site] = await db.select().from(sites).where(eq(sites.id, siteId));
    const baseDomain = process.env.BASE_DOMAIN || "cadmus.digital";
    const acceptUrl = `https://${baseDomain}/admin/accept-invite?token=${inviteToken}`;

    emailProvider
      .send({
        to: email,
        from: `Cadmus <noreply@${process.env.MAILGUN_DOMAIN || "cadmus.digital"}>`,
        subject: `You've been invited to ${site?.name || "a Cadmus site"}`,
        html: `
          <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:2rem">
            <h2 style="margin-bottom:1rem">You've been invited!</h2>
            <p>You've been invited to join <strong>${site?.name || "a site"}</strong> on Cadmus as ${role === "admin" ? "an" : "a"} <strong>${role}</strong>.</p>
            <p style="margin:1.5rem 0">
              <a href="${acceptUrl}" style="display:inline-block;padding:0.75rem 1.5rem;background:#1a1a1a;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">
                Accept Invitation
              </a>
            </p>
            <p style="color:#666;font-size:0.875rem">This invitation expires in 7 days.</p>
          </div>
        `,
        text: `You've been invited to join ${site?.name || "a site"} on Cadmus as a ${role}.\n\nAccept your invitation: ${acceptUrl}\n\nThis invitation expires in 7 days.`,
      })
      .catch((err) => console.error("Failed to send invite email:", err));
  }

  return c.json({ ok: true, memberId: member.id }, 201);
});

// ── GET /validate-invite — check if an invite token is still valid ────────

teamRoutes.get("/validate-invite", async (c) => {
  const token = c.req.query("token");
  if (!token) {
    return c.json({ valid: false, error: "Missing token" }, 400);
  }

  const [user] = await db.select().from(users).where(eq(users.inviteTokenHash, hashToken(token)));
  if (!user) {
    return c.json({ valid: false, error: "This invitation link is invalid or has already been used." });
  }

  if (!user.inviteTokenExpiry || new Date() > user.inviteTokenExpiry) {
    await db.update(users).set({ inviteTokenHash: null, inviteTokenExpiry: null }).where(eq(users.id, user.id));
    return c.json({ valid: false, error: "This invitation has expired." });
  }

  const [membership] = await db
    .select()
    .from(siteMembers)
    .where(and(eq(siteMembers.userId, user.id), eq(siteMembers.status, "invited")));

  if (!membership) {
    return c.json({ valid: false, error: "This invitation has already been accepted." });
  }

  return c.json({ valid: true, hasPassword: !!user.passwordHash, email: user.email });
});

// ── POST /accept-invite — accept an invitation ─────────────────────────────

teamRoutes.post("/accept-invite", async (c) => {
  const { token, password } = await c.req.json();

  if (!token) {
    return c.json({ error: "token is required" }, 400);
  }

  // Find the user with this invite token
  const [user] = await db.select().from(users).where(eq(users.inviteTokenHash, hashToken(token)));
  if (!user) {
    return c.json({ error: "Invalid or expired invitation" }, 400);
  }

  if (!user.inviteTokenExpiry || new Date() > user.inviteTokenExpiry) {
    await db.update(users).set({ inviteTokenHash: null, inviteTokenExpiry: null }).where(eq(users.id, user.id));
    return c.json({ error: "This invitation has expired" }, 400);
  }

  // Find the pending site_member entry
  const [membership] = await db
    .select()
    .from(siteMembers)
    .where(and(eq(siteMembers.userId, user.id), eq(siteMembers.status, "invited")));

  if (!membership) {
    return c.json({ error: "No pending invitation found" }, 400);
  }

  // If user has no password and one was provided, set it
  const updates: Record<string, unknown> = {
    inviteTokenHash: null,
    inviteTokenExpiry: null,
    // Clicking the invite link proves email ownership — mark as verified
    ...(!user.emailVerifiedAt ? { emailVerifiedAt: new Date() } : {}),
    // Only set default site if the user doesn't already have one
    ...(user.siteId ? {} : { siteId: membership.siteId }),
  };
  if (!user.passwordHash && password) {
    if (!meetsPasswordRequirements(password)) {
      return c.json({ error: "Password must be at least 12 characters and include an uppercase letter and a number or symbol" }, 400);
    }
    updates.passwordHash = hashPassword(password);
  }

  await db.update(users).set(updates).where(eq(users.id, user.id));

  // Activate the membership
  await db
    .update(siteMembers)
    .set({ status: "active", joinedAt: new Date() })
    .where(eq(siteMembers.id, membership.id));

  await db.insert(auditLog).values({
    siteId: membership.siteId,
    actorType: "user",
    actorId: user.id,
    action: "team.joined",
    entityType: "user",
    entityId: user.id,
    details: { role: membership.role },
  });

  return c.json({ ok: true, siteId: membership.siteId });
});

// ── PUT /:memberId/role — change a member's role ────────────────────────────

teamRoutes.put("/:memberId/role", requireRole("owner", "admin"), async (c) => {
  const authUser = c.get("user") as AuthUser;
  const memberId = c.req.param("memberId");
  const { role } = await c.req.json();

  const validRoles: SiteRole[] = ["admin", "editor", "viewer"];
  if (!validRoles.includes(role)) {
    return c.json({ error: `role must be one of: ${validRoles.join(", ")}` }, 400);
  }

  const [member] = await db.select().from(siteMembers).where(eq(siteMembers.id, memberId));
  if (!member || member.siteId !== authUser.siteId) {
    return c.json({ error: "Member not found" }, 404);
  }

  // Can't change the owner's role
  if (member.role === "owner") {
    return c.json({ error: "Cannot change the owner's role" }, 403);
  }

  // Admins can only manage editors and viewers
  if (authUser.role === "admin" && role === "admin") {
    return c.json({ error: "Only owners can assign admin role" }, 403);
  }

  await db.update(siteMembers).set({ role }).where(eq(siteMembers.id, memberId));

  await db.insert(auditLog).values({
    siteId: authUser.siteId,
    actorType: "user",
    actorId: authUser.id,
    action: "team.role_changed",
    entityType: "user",
    entityId: member.userId,
    details: { oldRole: member.role, newRole: role },
  });

  return c.json({ ok: true });
});

// ── DELETE /:memberId — remove a member ─────────────────────────────────────

teamRoutes.delete("/:memberId", async (c) => {
  const authUser = c.get("user") as AuthUser;
  const memberId = c.req.param("memberId");

  const [member] = await db.select().from(siteMembers).where(eq(siteMembers.id, memberId));
  if (!member || member.siteId !== authUser.siteId) {
    return c.json({ error: "Member not found" }, 404);
  }

  // Can't remove the owner
  if (member.role === "owner") {
    return c.json({ error: "Cannot remove the site owner" }, 403);
  }

  const isSelfRemoval = member.userId === authUser.id;

  if (isSelfRemoval) {
    // Can't leave if you're the only active member
    const activeMembers = await db
      .select({ id: siteMembers.id })
      .from(siteMembers)
      .where(and(eq(siteMembers.siteId, authUser.siteId), eq(siteMembers.status, "active")));
    if (activeMembers.length <= 1) {
      return c.json({ error: "Cannot leave — you are the only member of this site" }, 403);
    }

    // Can't leave if you're the billing responsible party
    const [sub] = await db
      .select({ billingUserId: subscriptions.billingUserId })
      .from(subscriptions)
      .where(eq(subscriptions.siteId, authUser.siteId));
    if (sub?.billingUserId === authUser.id) {
      return c.json({ error: "Cannot leave — you are the billing contact for this site. Transfer billing responsibility first." }, 403);
    }
  }

  if (!isSelfRemoval) {
    // Only owners/admins can remove other members
    const userLevel = { owner: 4, admin: 3, editor: 2, viewer: 1 }[authUser.role as string] || 0;
    if (userLevel < 3) {
      return c.json({ error: "Insufficient permissions" }, 403);
    }
    // Admins can only remove editors and viewers
    if (authUser.role === "admin" && member.role === "admin") {
      return c.json({ error: "Only owners can remove admins" }, 403);
    }
  }

  await db.update(siteMembers).set({ status: "removed" }).where(eq(siteMembers.id, memberId));

  await db.insert(auditLog).values({
    siteId: authUser.siteId,
    actorType: "user",
    actorId: authUser.id,
    action: isSelfRemoval ? "team.left" : "team.removed",
    entityType: "user",
    entityId: member.userId,
    details: { role: member.role },
  });

  return c.json({ ok: true });
});
