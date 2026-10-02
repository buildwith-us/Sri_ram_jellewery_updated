/**
 * REGISTRATION_ENABLED is read once at module load, so this file boots the app
 * with ALLOW_EMAIL_REGISTRATION=true in its own process.
 */
import { describe, it, expect } from "vitest";
import { useApp } from "../helpers/app.js";
import { User } from "../../server/models/User.js";

process.env.ALLOW_EMAIL_REGISTRATION = "true";
const ctx = useApp();

describe("POST /api/auth/register when enabled", () => {
  it("creates a USER and ignores a role in the body", async () => {
    const res = await ctx.api().post("/api/auth/register").send({ name: "N", email: "New@Shop.test", password: "secret12", role: "ADMIN" });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: "new@shop.test", role: "USER" });
    expect((await User.findOne({ email: "new@shop.test" }).lean()).role).toBe("USER");
  });

  it("duplicate email (any case) → 409", async () => {
    await ctx.api().post("/api/auth/register").send({ email: "dup@shop.test", password: "secret12" });
    const res = await ctx.api().post("/api/auth/register").send({ email: "DUP@shop.test", password: "secret12" });
    expect(res.status).toBe(409);
  });

  it("validation → 400", async () => {
    expect((await ctx.api().post("/api/auth/register").send({ email: "bad", password: "secret12" })).status).toBe(400);
    expect((await ctx.api().post("/api/auth/register").send({ email: "a@b.co", password: "123" })).status).toBe(400);
  });

  it("name defaults to the email's local part", async () => {
    const res = await ctx.api().post("/api/auth/register").send({ email: "priya@shop.test", password: "secret12" });
    expect(res.body.user.name).toBe("priya");
  });
});
