import { describe, it, expect } from "vitest";
import { api } from "../../test/helpers.js";

describe("Input validation (zod)", () => {
  it("rejects signup with a malformed email", async () => {
    const res = await api("POST", "/api/auth/signup", {
      body: { name: "Test", email: "not-an-email", password: "ValidPass123!" },
    });
    expect(res.status).toBe(400);
  });

  it("rejects signup missing required fields", async () => {
    const res = await api("POST", "/api/auth/signup", { body: { email: "a@b.com" } });
    expect(res.status).toBe(400);
  });

  it("rejects login with a non-string password", async () => {
    const res = await api("POST", "/api/auth/login", {
      body: { email: "a@b.com", password: 12345 },
    });
    expect(res.status).toBe(400);
  });

  it("accepts a well-formed login body (wrong creds -> 401, not 400)", async () => {
    const res = await api("POST", "/api/auth/login", {
      body: { email: "nobody@example.com", password: "whatever-but-string" },
    });
    expect(res.status).toBe(401);
  });
});
