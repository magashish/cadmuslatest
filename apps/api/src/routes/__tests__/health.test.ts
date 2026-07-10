import { describe, it, expect } from "vitest";
import { api } from "../../test/helpers.js";

describe("GET /api/health", () => {
  it("returns 200 with status ok", async () => {
    const res = await api("GET", "/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("GET /api/health/ready", () => {
  it("returns 200 when DB is reachable", async () => {
    const res = await api("GET", "/api/health/ready");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.checks.db).toBe("ok");
    expect(["ok", "skipped"]).toContain(body.checks.storage);
  });
});
