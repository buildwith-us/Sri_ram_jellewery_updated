/**
 * Limiters run with NODE_ENV=production here. In development the auth, OTP
 * and public-form limiters are skipped by design; that is checked at the end.
 * Each test gets a fresh client IP (and fresh phone numbers), so buckets
 * never carry over between tests.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { useApp } from "../helpers/app.js";
import { makeAdmin, uniquePhone } from "../helpers/factories.js";

const ctx = useApp();

const saved = {};
beforeAll(() => {
  for (const k of ["NODE_ENV", "MSG91_AUTH_KEY", "MSG91_TEMPLATE_ID"]) saved[k] = process.env[k];
  process.env.NODE_ENV = "production";
  // The test OTP is refused in production, so give OTP requests an SMS channel
  // (axios is mocked — nothing is sent).
  process.env.MSG91_AUTH_KEY = "k";
  process.env.MSG91_TEMPLATE_ID = "t";
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const hammer = async (n, fn) => {
  const out = [];
  for (let i = 0; i < n; i++) out.push((await fn(i)).status);
  return out;
};

describe("authLimiter (10 / 15 min / IP)", () => {
  it("11th login from one IP → 429; another IP is unaffected", async () => {
    const statuses = await hammer(11, () => ctx.api().post("/api/auth/login").send({ email: "x@y.co", password: "bad" }));
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
    const other = await ctx.api(null, { ip: "203.0.113.77" }).post("/api/auth/login").send({ email: "x@y.co", password: "bad" });
    expect(other.status).toBe(401);
  });

  it("the correct password is refused too once limited", async () => {
    const admin = await makeAdmin();
    await hammer(10, () => ctx.api().post("/api/auth/login").send({ email: admin.user.email, password: "bad" }));
    const res = await ctx.api().post("/api/auth/login").send({ email: admin.user.email, password: admin.password });
    expect(res.status).toBe(429);
  });

  it("password/forgot and password/reset are limited", async () => {
    const f = await hammer(11, () => ctx.api().post("/api/auth/password/forgot").send({ email: "a@b.co" }));
    expect(f[10]).toBe(429);
  });
});

describe("otpLimiter (10 / 5 min / phone)", () => {
  it("11th OTP request for one number → 429; a different number is unaffected", async () => {
    const phone = uniquePhone();
    const statuses = await hammer(11, () => ctx.api().post("/api/auth/otp/request").send({ phone }));
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect((await ctx.api().post("/api/auth/otp/request").send({ phone: uniquePhone() })).status).toBe(200);
  });
});

describe("otpVerifyLimiter (5 / 5 min / phone)", () => {
  it("6th guess for one number → 429", async () => {
    const phone = uniquePhone();
    await ctx.api().post("/api/auth/otp/request").send({ phone });
    const statuses = await hammer(6, () => ctx.api().post("/api/auth/otp/verify").send({ phone, otp: "000000" }));
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses[5]).toBe(429);
  });
});

describe("publicFormLimiter (5 / 15 min / IP)", () => {
  it("6th contact submission → 429", async () => {
    const statuses = await hammer(6, (i) => ctx.api().post("/api/contact").send({ name: "A", email: "a@b.co", message: `m${i}` }));
    expect(statuses.slice(0, 5).every((s) => s === 201)).toBe(true);
    expect(statuses[5]).toBe(429);
  });

  it("6th newsletter signup → 429", async () => {
    const statuses = await hammer(6, (i) => ctx.api().post("/api/newsletter").send({ email: `n${i}@b.co` }));
    expect(statuses[5]).toBe(429);
  });
});

describe("apiLimiter (200 / min / IP, always on)", () => {
  it("201st request in a minute → 429", async () => {
    const statuses = await Promise.all(Array.from({ length: 201 }, () => ctx.api().get("/api/rates").then((r) => r.status)));
    expect(statuses.filter((s) => s === 429)).toHaveLength(1);
  });
});

describe("development mode", () => {
  it("auth / OTP / public-form limiters are skipped, apiLimiter is not", async () => {
    process.env.NODE_ENV = "development";
    try {
      const logins = await hammer(15, () => ctx.api().post("/api/auth/login").send({ email: "x@y.co", password: "bad" }));
      expect(logins).not.toContain(429);
      const forms = await hammer(8, (i) => ctx.api().post("/api/contact").send({ name: "A", email: "a@b.co", message: `m${i}` }));
      expect(forms).not.toContain(429);
    } finally {
      process.env.NODE_ENV = "production";
    }
  });
});
