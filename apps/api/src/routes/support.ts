import { Hono } from "hono";
import { eq, desc, count, and } from "drizzle-orm";
import { db, supportTickets, supportTicketComments, platformSettings, sites, users, siteMembers } from "@cadmus/db";
import { requireAuth, requireGlobalRole } from "../middleware/auth.js";
import { getEmailProvider } from "../lib/email.js";
import type { AuthUser } from "@cadmus/shared";

export const supportRoutes = new Hono();

// All routes require authentication
supportRoutes.use("*", requireAuth);

// ── POST /api/support/tickets — submit a ticket (any authenticated user) ──

supportRoutes.post("/tickets", async (c) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const user = (c as any).get("user") as AuthUser;
  const body = await c.req.json() as {
    type?: string;
    subject?: string;
    body?: string;
    priority?: string;
  };

  const { type, subject, body: ticketBody, priority } = body;

  if (!type || !["support", "feature_request"].includes(type)) {
    return c.json({ error: "type must be 'support' or 'feature_request'" }, 400);
  }
  if (!subject?.trim()) return c.json({ error: "subject is required" }, 400);
  if (!ticketBody?.trim()) return c.json({ error: "body is required" }, 400);

  const [ticket] = await db.insert(supportTickets).values({
    siteId: user.siteId,
    userId: user.id,
    type,
    subject: subject.trim(),
    body: ticketBody.trim(),
    priority: priority === "high" ? "high" : priority === "low" ? "low" : "normal",
  }).returning();

  // Notify support team — fire and forget
  fireNotification(ticket, user).catch((err) =>
    console.error("[support] Notification failed:", err)
  );

  return c.json({ ticket }, 201);
});

// ── GET /api/support/tickets/mine — user's own tickets ────────────────────

supportRoutes.get("/tickets/mine", async (c) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const user = (c as any).get("user") as AuthUser;

  const tickets = await db
    .select()
    .from(supportTickets)
    .where(eq(supportTickets.siteId, user.siteId))
    .orderBy(desc(supportTickets.createdAt))
    .limit(50);

  return c.json({ tickets });
});

// ── GET /api/support/tickets — list all (cadmus_admin only) ───────────────

supportRoutes.get("/tickets", requireGlobalRole("cadmus_admin"), async (c) => {
  const status = c.req.query("status");
  const type = c.req.query("type");
  const limitParam = parseInt(c.req.query("limit") || "50");
  const offsetParam = parseInt(c.req.query("offset") || "0");
  const limit = Math.min(limitParam, 100);

  const rows = await db
    .select({
      ticket: supportTickets,
      siteName: sites.name,
      userEmail: users.email,
    })
    .from(supportTickets)
    .innerJoin(sites, eq(supportTickets.siteId, sites.id))
    .innerJoin(users, eq(supportTickets.userId, users.id))
    .where(
      status && type
        ? eq(supportTickets.status, status)
        : status
          ? eq(supportTickets.status, status)
          : type
            ? eq(supportTickets.type, type)
            : undefined
    )
    .orderBy(desc(supportTickets.createdAt))
    .limit(limit)
    .offset(offsetParam);

  const [{ value: total }] = await db
    .select({ value: count() })
    .from(supportTickets);

  return c.json({
    tickets: rows.map((r) => ({ ...r.ticket, siteName: r.siteName, userEmail: r.userEmail })),
    total,
  });
});

// ── PATCH /api/support/tickets/:id — update status/priority (cadmus_admin) ─

supportRoutes.patch("/tickets/:id", requireGlobalRole("cadmus_admin"), async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json() as { status?: string; priority?: string };

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.status && ["open", "in_progress", "resolved", "closed"].includes(body.status)) {
    updates.status = body.status;
  }
  if (body.priority && ["low", "normal", "high"].includes(body.priority)) {
    updates.priority = body.priority;
  }

  const [existing] = await db.select().from(supportTickets).where(eq(supportTickets.id, id));
  if (!existing) return c.json({ error: "Ticket not found" }, 404);

  const [ticket] = await db
    .update(supportTickets)
    .set(updates)
    .where(eq(supportTickets.id, id))
    .returning();

  if (!ticket) return c.json({ error: "Ticket not found" }, 404);

  if (updates.status === "resolved" && existing.status !== "resolved") {
    fireResolvedNotification(ticket).catch((err) =>
      console.error("[support] Resolved notification failed:", err)
    );
  }

  return c.json({ ticket });
});

// ── GET /api/support/settings — platform settings (cadmus_admin only) ────

supportRoutes.get("/settings", requireGlobalRole("cadmus_admin"), async (c) => {
  const rows = await db.select().from(platformSettings);
  const settings: Record<string, string> = {};
  for (const row of rows) settings[row.key] = row.value;
  return c.json({ settings });
});

// ── PUT /api/support/settings — update platform settings (cadmus_admin) ──

supportRoutes.put("/settings", requireGlobalRole("cadmus_admin"), async (c) => {
  const body = await c.req.json() as Record<string, string>;

  for (const [key, value] of Object.entries(body)) {
    if (typeof value !== "string") continue;
    await db
      .insert(platformSettings)
      .values({ key, value, updatedAt: new Date() })
      .onConflictDoUpdate({ target: platformSettings.key, set: { value, updatedAt: new Date() } });
  }

  return c.json({ ok: true });
});

// ── GET /api/support/tickets/:id/comments — fetch comments ───────────────

supportRoutes.get("/tickets/:id/comments", async (c) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const user = (c as any).get("user") as AuthUser;
  const ticketId = c.req.param("id");

  const isAdmin = user.globalRole === "cadmus_admin";

  // Verify ticket exists and (for non-admins) belongs to user's site
  const [ticket] = await db.select().from(supportTickets).where(eq(supportTickets.id, ticketId));
  if (!ticket) return c.json({ error: "Ticket not found" }, 404);
  if (!isAdmin && ticket.siteId !== user.siteId) return c.json({ error: "Forbidden" }, 403);

  const rows = await db
    .select({
      comment: supportTicketComments,
      authorEmail: users.email,
      authorFirstName: users.firstName,
    })
    .from(supportTicketComments)
    .innerJoin(users, eq(supportTicketComments.authorId, users.id))
    .where(
      isAdmin
        ? eq(supportTicketComments.ticketId, ticketId)
        : and(eq(supportTicketComments.ticketId, ticketId), eq(supportTicketComments.isInternal, false))
    )
    .orderBy(supportTicketComments.createdAt);

  return c.json({
    comments: rows.map((r) => ({
      ...r.comment,
      authorEmail: r.authorEmail,
      authorName: r.authorFirstName || r.authorEmail,
    })),
  });
});

// ── POST /api/support/tickets/:id/comments — add comment (cadmus_admin) ──

supportRoutes.post("/tickets/:id/comments", requireGlobalRole("cadmus_admin"), async (c) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const user = (c as any).get("user") as AuthUser;
  const ticketId = c.req.param("id");
  const body = await c.req.json() as { body?: string; isInternal?: boolean };

  if (!body.body?.trim()) return c.json({ error: "body is required" }, 400);

  const [ticket] = await db.select().from(supportTickets).where(eq(supportTickets.id, ticketId));
  if (!ticket) return c.json({ error: "Ticket not found" }, 404);

  const [comment] = await db.insert(supportTicketComments).values({
    ticketId,
    authorId: user.id,
    body: body.body.trim(),
    isInternal: body.isInternal ?? false,
  }).returning();

  if (!body.isInternal) {
    fireCommentNotification(ticket, comment, user).catch((err) =>
      console.error("[support] Comment notification failed:", err)
    );
  }

  return c.json({ comment }, 201);
});

// ── Internal: send resolved notification email to ticket owner ───────────

async function fireResolvedNotification(
  ticket: typeof supportTickets.$inferSelect,
): Promise<void> {
  const provider = getEmailProvider();
  if (!provider) return;

  const [ticketOwner] = await db
    .select({ email: users.email, firstName: users.firstName })
    .from(users)
    .where(eq(users.id, ticket.userId));

  if (!ticketOwner) return;

  const name = ticketOwner.firstName || ticketOwner.email.split("@")[0];
  const from = `Cadmus Support <noreply@${process.env.MAILGUN_DOMAIN || "cadmus.digital"}>`;

  provider.send({
    to: ticketOwner.email,
    from,
    subject: `Resolved: ${ticket.subject}`,
    html: `
      <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:2rem;color:#1a1a1a">
        <p style="margin-top:0">Hi ${name},</p>
        <p>Your support request has been marked as resolved:</p>
        <p style="font-weight:600">${ticket.subject}</p>
        <p style="color:#666;font-size:0.875rem">If you're still experiencing issues or have follow-up questions, feel free to open a new request from the <strong>Help &amp; Support</strong> section of your admin panel.</p>
        <p style="color:#666;font-size:0.875rem">— The Cadmus Team</p>
      </div>
    `,
  }).catch((err) => console.error(`[support] Resolved email to ${ticketOwner.email} failed:`, err));
}

// ── Internal: send notification email to support team ─────────────────────

async function fireCommentNotification(
  ticket: typeof supportTickets.$inferSelect,
  comment: typeof supportTicketComments.$inferSelect,
  admin: AuthUser,
): Promise<void> {
  const provider = getEmailProvider();
  if (!provider) return;

  const [ticketOwner] = await db
    .select({ email: users.email, firstName: users.firstName })
    .from(users)
    .where(eq(users.id, ticket.userId));

  if (!ticketOwner) return;

  const name = ticketOwner.firstName || ticketOwner.email.split("@")[0];
  const from = `Cadmus Support <noreply@${process.env.MAILGUN_DOMAIN || "cadmus.digital"}>`;

  provider.send({
    to: ticketOwner.email,
    from,
    subject: `Re: ${ticket.subject}`,
    html: `
      <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:2rem;color:#1a1a1a">
        <p style="margin-top:0">Hi ${name},</p>
        <p>We've added a reply to your support request: <strong>${ticket.subject}</strong></p>
        <div style="background:#f5f5f5;border-radius:6px;padding:1rem;white-space:pre-wrap;margin:1.5rem 0">${comment.body}</div>
        <p style="color:#666;font-size:0.875rem">You can check the status of your request in the <strong>Help &amp; Support</strong> section of your admin panel.</p>
        <p style="color:#666;font-size:0.875rem">— The Cadmus Team</p>
      </div>
    `,
  }).catch((err) => console.error(`[support] Comment email to ${ticketOwner.email} failed:`, err));
}

async function fireNotification(
  ticket: typeof supportTickets.$inferSelect,
  submitter: AuthUser,
): Promise<void> {
  const provider = getEmailProvider();
  if (!provider) return;

  const [notifSetting] = await db
    .select()
    .from(platformSettings)
    .where(eq(platformSettings.key, "support_notification_emails"));

  if (!notifSetting?.value) return;

  const emails = notifSetting.value
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);

  if (emails.length === 0) return;

  const [site] = await db.select({ name: sites.name }).from(sites).where(eq(sites.id, ticket.siteId));
  const [owner] = await db
    .select({ firstName: users.firstName, email: users.email })
    .from(siteMembers)
    .innerJoin(users, eq(siteMembers.userId, users.id))
    .where(eq(siteMembers.siteId, ticket.siteId))
    .limit(1);

  const typeLabel = ticket.type === "feature_request" ? "Feature Request" : "Support Ticket";
  const priorityBadge = ticket.priority === "high" ? " 🔴 HIGH PRIORITY" : "";
  const from = `Cadmus <noreply@${process.env.MAILGUN_DOMAIN || "cadmus.digital"}>`;
  const dashboardUrl = `https://${process.env.BASE_DOMAIN === "cadmus.digital" ? "dashboard" : "dashboard-dev"}.cadmus.digital/support`;

  for (const to of emails) {
    provider.send({
      to,
      from,
      subject: `[${typeLabel}${priorityBadge}] ${ticket.subject}`,
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:2rem;color:#1a1a1a">
          <h2 style="margin-top:0">New ${typeLabel}</h2>
          <table style="width:100%;border-collapse:collapse;margin-bottom:1.5rem">
            <tr><td style="padding:4px 0;color:#666;width:120px">Site</td><td><strong>${site?.name ?? ticket.siteId}</strong></td></tr>
            <tr><td style="padding:4px 0;color:#666">From</td><td>${owner?.firstName ? `${owner.firstName} — ` : ""}${owner?.email ?? submitter.email}</td></tr>
            <tr><td style="padding:4px 0;color:#666">Priority</td><td>${ticket.priority}</td></tr>
            <tr><td style="padding:4px 0;color:#666">Subject</td><td>${ticket.subject}</td></tr>
          </table>
          <div style="background:#f5f5f5;border-radius:6px;padding:1rem;white-space:pre-wrap">${ticket.body}</div>
          <p style="margin-top:1.5rem">
            <a href="${dashboardUrl}" style="display:inline-block;padding:0.6rem 1.25rem;background:#1a1a1a;color:#fff;border-radius:6px;text-decoration:none">
              View in Dashboard
            </a>
          </p>
        </div>
      `,
    }).catch((err) => console.error(`[support] Email to ${to} failed:`, err));
  }
}
