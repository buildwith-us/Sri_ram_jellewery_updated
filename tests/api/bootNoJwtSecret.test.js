/**
 * JWT_SECRET is read once at module load. Without it the server must fail
 * closed on authentication while public routes keep working.
 */
import { describe, it, expect } from "vitest";
import { useApp } from "../helpers/app.js";

delete process.env.JWT_SECRET;
const ctx = useApp();

describe("JWT_SECRET unset (NODE_ENV=test)", () => {
  it("protected routes → 503 AUTH_UNCONFIGURED", async () => {
    const res = await ctx.api("anything").get("/api/users/me");
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("AUTH_UNCONFIGURED");
  });

  it("every auth route → 503, never a crash", async () => {
    for (const p of ["/api/auth/login", "/api/auth/otp/request", "/api/auth/refresh"]) {
      expect((await ctx.api().post(p).send({})).status).toBe(503);
    }
  });

  it("public routes still serve", async () => {
    expect((await ctx.api().get("/api/products")).status).toBe(200);
    expect((await ctx.api().get("/api/rates")).status).toBe(200);
  });

  it("optional-auth view tracking ignores the token instead of failing", async () => {
    const res = await ctx.api("anything").post("/api/products/x/view").send({ sessionId: "s" });
    expect(res.status).toBe(404);
  });
});
