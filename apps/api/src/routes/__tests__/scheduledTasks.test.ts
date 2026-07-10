import { describe, it, expect, beforeEach } from "vitest";
import { db, scheduledTasks } from "@cadmus/db";
import { eq } from "drizzle-orm";
import { api, createTestSite, createTestUser, authHeaders } from "../../test/helpers.js";

describe("Scheduled Tasks routes", () => {
  let site: any;
  let user: any;
  let headers: Record<string, string>;

  beforeEach(async () => {
    site = await createTestSite();
    user = await createTestUser(site.id);
    headers = await authHeaders(user.id, user.email, user.role, site.id);
  });

  const futureDate = new Date(Date.now() + 86400000).toISOString(); // +1 day

  describe("POST /api/scheduled-tasks", () => {
    it("creates a scheduled task", async () => {
      const res = await api("POST", "/api/scheduled-tasks", {
        headers,
        body: {
          taskType: "publish_content",
          runAt: futureDate,
          payload: { contentId: "abc" },
        },
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.taskType).toBe("publish_content");
      expect(data.status).toBe("pending");
      expect(data.payload).toEqual({ contentId: "abc" });
    });

    it("returns 400 without required fields", async () => {
      const res = await api("POST", "/api/scheduled-tasks", {
        headers,
        body: { taskType: "publish_content" },
      });
      expect(res.status).toBe(400);
    });

    it("supports recurrence", async () => {
      const res = await api("POST", "/api/scheduled-tasks", {
        headers,
        body: {
          taskType: "seo_audit",
          runAt: futureDate,
          recurrence: "0 0 * * 1", // weekly Monday
        },
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.recurrence).toBe("0 0 * * 1");
    });
  });

  describe("GET /api/scheduled-tasks", () => {
    it("lists tasks with filtering", async () => {
      await api("POST", "/api/scheduled-tasks", {
        headers,
        body: { taskType: "publish_content", runAt: futureDate },
      });
      await api("POST", "/api/scheduled-tasks", {
        headers,
        body: { taskType: "seo_audit", runAt: futureDate },
      });

      const res = await api("GET", "/api/scheduled-tasks?taskType=seo_audit", { headers });
      const data = await res.json();
      expect(data.items).toHaveLength(1);
      expect(data.items[0].taskType).toBe("seo_audit");
    });
  });

  describe("GET /api/scheduled-tasks/:id", () => {
    it("returns a single task", async () => {
      const createRes = await api("POST", "/api/scheduled-tasks", {
        headers,
        body: { taskType: "publish_content", runAt: futureDate },
      });
      const created = await createRes.json();

      const res = await api("GET", `/api/scheduled-tasks/${created.id}`, { headers });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.id).toBe(created.id);
    });
  });

  describe("PUT /api/scheduled-tasks/:id", () => {
    it("updates a pending task", async () => {
      const createRes = await api("POST", "/api/scheduled-tasks", {
        headers,
        body: { taskType: "publish_content", runAt: futureDate },
      });
      const created = await createRes.json();

      const newDate = new Date(Date.now() + 172800000).toISOString(); // +2 days
      const res = await api("PUT", `/api/scheduled-tasks/${created.id}`, {
        headers,
        body: { runAt: newDate, payload: { updated: true } },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.payload).toEqual({ updated: true });
    });

    it("rejects update of non-pending task (409)", async () => {
      const createRes = await api("POST", "/api/scheduled-tasks", {
        headers,
        body: { taskType: "publish_content", runAt: futureDate },
      });
      const created = await createRes.json();

      // Manually set to running
      await db
        .update(scheduledTasks)
        .set({ status: "running" })
        .where(eq(scheduledTasks.id, created.id));

      const res = await api("PUT", `/api/scheduled-tasks/${created.id}`, {
        headers,
        body: { payload: { nope: true } },
      });
      expect(res.status).toBe(409);
    });
  });

  describe("POST /api/scheduled-tasks/:id/cancel", () => {
    it("cancels a pending task", async () => {
      const createRes = await api("POST", "/api/scheduled-tasks", {
        headers,
        body: { taskType: "publish_content", runAt: futureDate },
      });
      const created = await createRes.json();

      const res = await api("POST", `/api/scheduled-tasks/${created.id}/cancel`, {
        headers,
        body: {},
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe("cancelled");
    });

    it("rejects cancel of completed task (409)", async () => {
      const createRes = await api("POST", "/api/scheduled-tasks", {
        headers,
        body: { taskType: "publish_content", runAt: futureDate },
      });
      const created = await createRes.json();

      await db
        .update(scheduledTasks)
        .set({ status: "completed" })
        .where(eq(scheduledTasks.id, created.id));

      const res = await api("POST", `/api/scheduled-tasks/${created.id}/cancel`, {
        headers,
        body: {},
      });
      expect(res.status).toBe(409);
    });
  });

  describe("DELETE /api/scheduled-tasks/:id", () => {
    it("deletes a pending task", async () => {
      const createRes = await api("POST", "/api/scheduled-tasks", {
        headers,
        body: { taskType: "publish_content", runAt: futureDate },
      });
      const created = await createRes.json();

      const res = await api("DELETE", `/api/scheduled-tasks/${created.id}`, { headers });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ deleted: true });
    });

    it("deletes a cancelled task", async () => {
      const createRes = await api("POST", "/api/scheduled-tasks", {
        headers,
        body: { taskType: "publish_content", runAt: futureDate },
      });
      const created = await createRes.json();

      // Cancel first
      await api("POST", `/api/scheduled-tasks/${created.id}/cancel`, {
        headers,
        body: {},
      });

      const res = await api("DELETE", `/api/scheduled-tasks/${created.id}`, { headers });
      expect(res.status).toBe(200);
    });

    it("rejects delete of running task (409)", async () => {
      const createRes = await api("POST", "/api/scheduled-tasks", {
        headers,
        body: { taskType: "publish_content", runAt: futureDate },
      });
      const created = await createRes.json();

      await db
        .update(scheduledTasks)
        .set({ status: "running" })
        .where(eq(scheduledTasks.id, created.id));

      const res = await api("DELETE", `/api/scheduled-tasks/${created.id}`, { headers });
      expect(res.status).toBe(409);
    });
  });
});
