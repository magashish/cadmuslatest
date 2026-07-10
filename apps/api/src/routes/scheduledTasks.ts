import { Hono } from "hono";
import { eq, and, sql, desc } from "drizzle-orm";
import { db, scheduledTasks, auditLog } from "@cadmus/db";
import type { SiteEnv } from "../middleware/tenant.js";
import type { AuthUser } from "@cadmus/shared";

export const scheduledTasksRoutes = new Hono<SiteEnv & { Variables: { user: AuthUser } }>();

// List scheduled tasks with filtering and pagination
scheduledTasksRoutes.get("/", async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) {
    return c.json({ error: "Site context is required" }, 400);
  }

  const status = c.req.query("status");
  const taskType = c.req.query("taskType");
  const limit = Math.min(Number(c.req.query("limit")) || 50, 100);
  const offset = Number(c.req.query("offset")) || 0;

  const conditions = [eq(scheduledTasks.siteId, siteId)];
  if (status) conditions.push(eq(scheduledTasks.status, status));
  if (taskType) conditions.push(eq(scheduledTasks.taskType, taskType));

  const [items, countResult] = await Promise.all([
    db
      .select()
      .from(scheduledTasks)
      .where(and(...conditions))
      .orderBy(desc(scheduledTasks.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)` })
      .from(scheduledTasks)
      .where(and(...conditions)),
  ]);

  return c.json({ items, total: Number(countResult[0].count) });
});

// Get single scheduled task
scheduledTasksRoutes.get("/:id", async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) {
    return c.json({ error: "Site context is required" }, 400);
  }
  const id = c.req.param("id");

  const [item] = await db
    .select()
    .from(scheduledTasks)
    .where(and(eq(scheduledTasks.id, id), eq(scheduledTasks.siteId, siteId)));
  if (!item) {
    return c.json({ error: "Scheduled task not found" }, 404);
  }

  return c.json(item);
});

// Create scheduled task
scheduledTasksRoutes.post("/", async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) {
    return c.json({ error: "Site context is required" }, 400);
  }

  const user = c.get("user");
  const body = await c.req.json();
  const { taskType, runAt, payload, recurrence } = body;

  if (!taskType || !runAt) {
    return c.json({ error: "taskType and runAt are required" }, 400);
  }

  const [item] = await db
    .insert(scheduledTasks)
    .values({
      siteId,
      taskType,
      runAt: new Date(runAt),
      nextRunAt: new Date(runAt),
      payload: payload || {},
      recurrence: recurrence || null,
      status: "pending",
      createdBy: user.id,
    })
    .returning();

  await db.insert(auditLog).values({
    siteId,
    actorType: "user",
    actorId: user.id,
    action: "scheduled_task.created",
    entityType: "scheduled_task",
    entityId: item.id,
    details: { taskType, runAt },
  });

  return c.json(item, 201);
});

// Update pending scheduled task
scheduledTasksRoutes.put("/:id", async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) {
    return c.json({ error: "Site context is required" }, 400);
  }
  const id = c.req.param("id");
  const user = c.get("user");
  const body = await c.req.json();
  const { runAt, payload, recurrence } = body;

  const [existing] = await db
    .select()
    .from(scheduledTasks)
    .where(and(eq(scheduledTasks.id, id), eq(scheduledTasks.siteId, siteId)));
  if (!existing) {
    return c.json({ error: "Scheduled task not found" }, 404);
  }

  if (existing.status !== "pending") {
    return c.json({ error: "Only pending tasks can be updated" }, 409);
  }

  const updates: Record<string, unknown> = {};
  if (runAt !== undefined) {
    updates.runAt = new Date(runAt);
    updates.nextRunAt = new Date(runAt);
  }
  if (payload !== undefined) updates.payload = payload;
  if (recurrence !== undefined) updates.recurrence = recurrence;

  const [updated] = await db
    .update(scheduledTasks)
    .set(updates)
    .where(eq(scheduledTasks.id, id))
    .returning();

  await db.insert(auditLog).values({
    siteId: existing.siteId,
    actorType: "user",
    actorId: user.id,
    action: "scheduled_task.updated",
    entityType: "scheduled_task",
    entityId: id,
    details: { changes: Object.keys(updates) },
  });

  return c.json(updated);
});

// Cancel a pending or running task
scheduledTasksRoutes.post("/:id/cancel", async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) {
    return c.json({ error: "Site context is required" }, 400);
  }
  const id = c.req.param("id");
  const user = c.get("user");

  const [existing] = await db
    .select()
    .from(scheduledTasks)
    .where(and(eq(scheduledTasks.id, id), eq(scheduledTasks.siteId, siteId)));
  if (!existing) {
    return c.json({ error: "Scheduled task not found" }, 404);
  }

  if (existing.status !== "pending" && existing.status !== "running") {
    return c.json({ error: "Only pending or running tasks can be cancelled" }, 409);
  }

  const [updated] = await db
    .update(scheduledTasks)
    .set({ status: "cancelled" })
    .where(eq(scheduledTasks.id, id))
    .returning();

  await db.insert(auditLog).values({
    siteId: existing.siteId,
    actorType: "user",
    actorId: user.id,
    action: "scheduled_task.cancelled",
    entityType: "scheduled_task",
    entityId: id,
  });

  return c.json(updated);
});

// Delete a pending or cancelled task
scheduledTasksRoutes.delete("/:id", async (c) => {
  const siteId = c.get("site")?.siteId;
  if (!siteId) {
    return c.json({ error: "Site context is required" }, 400);
  }
  const id = c.req.param("id");
  const user = c.get("user");

  const [existing] = await db
    .select()
    .from(scheduledTasks)
    .where(and(eq(scheduledTasks.id, id), eq(scheduledTasks.siteId, siteId)));
  if (!existing) {
    return c.json({ error: "Scheduled task not found" }, 404);
  }

  if (existing.status !== "pending" && existing.status !== "cancelled") {
    return c.json({ error: "Only pending or cancelled tasks can be deleted" }, 409);
  }

  await db.delete(scheduledTasks).where(eq(scheduledTasks.id, id));

  await db.insert(auditLog).values({
    siteId: existing.siteId,
    actorType: "user",
    actorId: user.id,
    action: "scheduled_task.deleted",
    entityType: "scheduled_task",
    entityId: id,
    details: { taskType: existing.taskType },
  });

  return c.json({ deleted: true });
});
