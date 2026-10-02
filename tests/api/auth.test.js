import { describe, it, expect, afterEach } from "vitest";
import crypto from "node:crypto";
import { useApp, mocks } from "../helpers/app.js";
import {
  uniquePhone,
  customerViaOtp,
  makeAdmin,
  makeCustomer,
  ADMIN_PASSWORD,
  tokenFor,
} from "../helpers/factories.js";
import { User } from "../../server/models/User.js";
import { RefreshToken } from "../../server/models/RefreshToken.js";
import { PasswordResetToken } from "../../server/models/PasswordResetToken.js";

const ctx = useApp();
const api = (...a) => ctx.api(...a);

// Env tweaks made inside a test are undone here.
const envBackup = {};
const setEnv = (k, v) => {
  if (!(k in envBackup)) envBackup[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
};
afterEach(() => {
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete envBackup[k];
  }
});

const requestOtp = (phone) => api().post("/api/auth/otp/request").send({ phone });
const verifyOtp = (phone, otp = "123456") => api().post("/api/auth/otp/verify").send({ phone, otp });

describe("POST /api/auth/otp/request", () => {
  it("creates a USER with the canonical phone and a 5-minute hashed OTP", async () => {
    const phone = uniquePhone();
    const res = await requestOtp(phone);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, message: "OTP sent successfully" });
    const u = await User.findOne({ phone: `+91${phone}` }).lean();
    expect(u.role).toBe("USER");
    expect(u.otpHash).toMatch(/^\$2[aby]\$/);
    expect(u.otpHash).not.toContain("123456");
    const ttl = u.otpExpiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(4.5 * 60_000);
    expect(ttl).toBeLessThanOrEqual(5 * 60_000);
  });

  it("different spellings of one number resolve to one account", async () => {
    const phone = uniquePhone();
    await requestOtp(phone);
    await requestOtp(`+91 ${phone}`);
    await requestOtp(`0${phone}`);
    expect(await User.countDocuments({})).toBe(1);
  });

  it.each([["12345"], ["abcdefghij"], [""], [undefined]])("invalid phone %s → 400", async (phone) => {
    const res = await requestOtp(phone);
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it("with no SMS and no test OTP → 503 and nothing stored", async () => {
    setEnv("ALLOW_TEST_OTP", undefined);
    const res = await requestOtp(uniquePhone());
    expect(res.status).toBe(503);
    expect(await User.countDocuments({})).toBe(0);
  });

  it.each([
    ["TRUE", "TRUE"],
    ["empty string", ""],
    ["false", "false"],
    ["1", "1"],
  ])("ALLOW_TEST_OTP=%s does not enable the bypass", async (_l, value) => {
    setEnv("ALLOW_TEST_OTP", value);
    expect((await requestOtp(uniquePhone())).status).toBe(503);
  });

  it("NODE_ENV=production disables the bypass even with ALLOW_TEST_OTP=true", async () => {
    setEnv("NODE_ENV", "production");
    expect((await requestOtp(uniquePhone())).status).toBe(503);
  });

  it("VERCEL_ENV=production disables the bypass even with ALLOW_TEST_OTP=true", async () => {
    setEnv("VERCEL_ENV", "production");
    expect((await requestOtp(uniquePhone())).status).toBe(503);
  });

  it("TEST_OTP_PHONES confines the bypass to listed numbers (with or without +91)", async () => {
    const allowed = uniquePhone();
    const alsoAllowed = uniquePhone();
    setEnv("TEST_OTP_PHONES", `${allowed}, +91${alsoAllowed}`);
    expect((await requestOtp(allowed)).status).toBe(200);
    expect((await verifyOtp(allowed)).status).toBe(200);
    expect((await requestOtp(`+91${alsoAllowed}`)).status).toBe(200);
    expect((await requestOtp(uniquePhone())).status).toBe(503);
  });

  it("with MSG91 configured: sends a random OTP, strips '+', and 123456 is not accepted", async () => {
    setEnv("MSG91_AUTH_KEY", "auth-key");
    setEnv("MSG91_TEMPLATE_ID", "tmpl");
    const phone = uniquePhone();
    expect((await requestOtp(phone)).status).toBe(200);
    const url = mocks().msg91Post.mock.calls[0][0];
    expect(url).toContain(`mobile=91${phone}`);
    expect(url).not.toContain("%2B");
    const sentOtp = new URL(url).searchParams.get("otp");
    expect(sentOtp).toMatch(/^\d{6}$/);
    if (sentOtp !== "123456") expect((await verifyOtp(phone)).status).toBe(401);
    expect((await verifyOtp(phone, sentOtp)).status).toBe(200);
  });

  it("MSG91 failure still answers 200 (the code is stored; delivery failed)", async () => {
    setEnv("MSG91_AUTH_KEY", "auth-key");
    setEnv("MSG91_TEMPLATE_ID", "tmpl");
    mocks().msg91Post.mockRejectedValueOnce(Object.assign(new Error("boom"), { response: { data: "x" } }));
    expect((await requestOtp(uniquePhone())).status).toBe(200);
  });

  it("admin phone: same 200 body as any number, and no OTP is stored", async () => {
    const phone = uniquePhone();
    const { user } = await makeAdmin({ phone: `+91${phone}` });
    const adminRes = await requestOtp(phone);
    const normalRes = await requestOtp(uniquePhone());
    expect(adminRes.status).toBe(normalRes.status);
    expect(adminRes.body).toEqual(normalRes.body);
    const after = await User.findById(user._id).lean();
    expect(after.otpHash).toBeUndefined();
  });
});

describe("POST /api/auth/otp/verify", () => {
  it("happy path: tokens, USER role, OTP cleared", async () => {
    const phone = uniquePhone();
    await requestOtp(phone);
    const res = await verifyOtp(`+91-${phone}`);
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toMatch(/^[0-9a-f]{80}$/);
    expect(res.body.user).toMatchObject({ phone: `+91${phone}`, role: "USER" });
    const u = await User.findOne({ phone: `+91${phone}` }).lean();
    expect(u.otpHash).toBeUndefined();
    expect(u.otpExpiresAt).toBeUndefined();
    // Only the hash of the refresh token is stored.
    const stored = await RefreshToken.findOne({ userId: u._id }).lean();
    expect(stored.tokenHash).toBe(crypto.createHash("sha256").update(res.body.refreshToken).digest("hex"));
  });

  it("the access token works on a protected route", async () => {
    const { token } = await customerViaOtp(api);
    expect((await api(token).get("/api/users/me")).status).toBe(200);
  });

  it("wrong OTP → 401", async () => {
    const phone = uniquePhone();
    await requestOtp(phone);
    const res = await verifyOtp(phone, "000000");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid OTP");
  });

  it("expired OTP → 401", async () => {
    const phone = uniquePhone();
    await requestOtp(phone);
    await User.updateOne({ phone: `+91${phone}` }, { otpExpiresAt: new Date(Date.now() - 1000) });
    const res = await verifyOtp(phone);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("OTP has expired");
  });

  it("an OTP cannot be reused after a successful sign-in", async () => {
    const phone = uniquePhone();
    await requestOtp(phone);
    expect((await verifyOtp(phone)).status).toBe(200);
    expect((await verifyOtp(phone)).status).toBe(401);
  });

  it("no prior request → 401", async () => {
    expect((await verifyOtp(uniquePhone())).status).toBe(401);
  });

  it("missing OTP or bad phone → 400", async () => {
    expect((await api().post("/api/auth/otp/verify").send({ phone: uniquePhone() })).status).toBe(400);
    expect((await verifyOtp("123")).status).toBe(400);
  });

  it("admin phone is refused with the same response as an unknown number", async () => {
    const phone = uniquePhone();
    await makeAdmin({ phone: `+91${phone}` });
    await requestOtp(phone);
    const adminRes = await verifyOtp(phone);
    const unknownRes = await verifyOtp(uniquePhone());
    expect(adminRes.status).toBe(401);
    expect(adminRes.body).toEqual(unknownRes.body);
  });

  it("admin with an OTP hash planted directly is still refused", async () => {
    const phone = uniquePhone();
    const bcrypt = (await import("bcrypt")).default;
    await makeAdmin({
      phone: `+91${phone}`,
      otpHash: await bcrypt.hash("123456", 4),
      otpExpiresAt: new Date(Date.now() + 60_000),
    });
    const res = await verifyOtp(phone);
    expect(res.status).toBe(401);
    expect(res.body.accessToken).toBeUndefined();
  });
});

describe("POST /api/auth/register", () => {
  it("is 404 unless ALLOW_EMAIL_REGISTRATION=true", async () => {
    const res = await api().post("/api/auth/register").send({ email: "x@y.co", password: "secret12" });
    expect(res.status).toBe(404);
    expect(await User.countDocuments({})).toBe(0);
  });
});

describe("POST /api/auth/login (admin)", () => {
  it("valid credentials → tokens and the admin user", async () => {
    const { user } = await makeAdmin();
    const res = await api().post("/api/auth/login").send({ email: user.email, password: ADMIN_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ role: "ADMIN", email: user.email });
    expect(res.body.user.passwordHash).toBeUndefined();
    expect(res.body.accessToken).toBeTruthy();
  });

  it("email is case-insensitive", async () => {
    const { user } = await makeAdmin();
    const res = await api().post("/api/auth/login").send({ email: user.email.toUpperCase(), password: ADMIN_PASSWORD });
    expect(res.status).toBe(200);
  });

  it("a TLD-less address like the seeded admin@buildwithus still signs in", async () => {
    await makeAdmin({ email: "admin@buildwithus" });
    const res = await api().post("/api/auth/login").send({ email: "admin@buildwithus", password: ADMIN_PASSWORD });
    expect(res.status).toBe(200);
  });

  it("wrong password, unknown email and password-less account share one 401 message", async () => {
    const { user } = await makeAdmin();
    await makeCustomer({ email: "customer@shop.test" });
    const a = await api().post("/api/auth/login").send({ email: user.email, password: "nope" });
    const b = await api().post("/api/auth/login").send({ email: "nobody@shop.test", password: "nope" });
    const c = await api().post("/api/auth/login").send({ email: "customer@shop.test", password: "nope" });
    for (const r of [a, b, c]) {
      expect(r.status).toBe(401);
      expect(r.body.error).toBe("Invalid email or password");
    }
  });

  it("missing fields → 400", async () => {
    expect((await api().post("/api/auth/login").send({ email: "a@b.co" })).status).toBe(400);
    expect((await api().post("/api/auth/login").send({})).status).toBe(400);
  });

  it("admin login deletes the admin's older refresh tokens (single admin session)", async () => {
    const { user } = await makeAdmin();
    const creds = { email: user.email, password: ADMIN_PASSWORD };
    const first = await api().post("/api/auth/login").send(creds);
    const second = await api().post("/api/auth/login").send(creds);
    expect(await RefreshToken.countDocuments({ userId: user._id })).toBe(1);
    expect((await api().post("/api/auth/refresh").send({ refreshToken: first.body.refreshToken })).status).toBe(401);
    expect((await api().post("/api/auth/refresh").send({ refreshToken: second.body.refreshToken })).status).toBe(200);
  });

  it("customers keep concurrent sessions", async () => {
    const phone = uniquePhone();
    const a = await customerViaOtp(api, phone);
    const b = await customerViaOtp(api, phone);
    expect((await api().post("/api/auth/refresh").send({ refreshToken: a.refreshToken })).status).toBe(200);
    expect((await api().post("/api/auth/refresh").send({ refreshToken: b.refreshToken })).status).toBe(200);
  });
});

describe("POST /api/auth/refresh", () => {
  it("rotates: new access + refresh token, old one spent", async () => {
    const s = await customerViaOtp(api);
    const res = await api().post("/api/auth/refresh").send({ refreshToken: s.refreshToken });
    expect(res.status).toBe(200);
    expect(res.body.refreshToken).not.toBe(s.refreshToken);
    expect((await api(res.body.accessToken).get("/api/users/me")).status).toBe(200);
  });

  it("reusing a spent refresh token → 401 and revokes every session for that user", async () => {
    const s = await customerViaOtp(api);
    const rotated = await api().post("/api/auth/refresh").send({ refreshToken: s.refreshToken });
    const replay = await api().post("/api/auth/refresh").send({ refreshToken: s.refreshToken });
    expect(replay.status).toBe(401);
    expect(replay.body.error).toMatch(/ended for your security/);
    // The legitimate client's fresh token is gone too.
    expect((await api().post("/api/auth/refresh").send({ refreshToken: rotated.body.refreshToken })).status).toBe(401);
  });

  it("two concurrent refreshes with the same token: exactly one succeeds", async () => {
    const s = await customerViaOtp(api);
    const results = await Promise.all(
      [1, 2, 3].map(() => api().post("/api/auth/refresh").send({ refreshToken: s.refreshToken }))
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });

  it("unknown token → 401 and revokes nothing", async () => {
    const s = await customerViaOtp(api);
    expect((await api().post("/api/auth/refresh").send({ refreshToken: "f".repeat(80) })).status).toBe(401);
    expect((await api().post("/api/auth/refresh").send({ refreshToken: s.refreshToken })).status).toBe(200);
  });

  it("expired stored token → 401", async () => {
    const s = await customerViaOtp(api);
    await RefreshToken.updateMany({}, { expiresAt: new Date(Date.now() - 1000) });
    const res = await api().post("/api/auth/refresh").send({ refreshToken: s.refreshToken });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Refresh token expired");
  });

  it("deleted user → 401", async () => {
    const s = await customerViaOtp(api);
    await User.deleteMany({});
    expect((await api().post("/api/auth/refresh").send({ refreshToken: s.refreshToken })).status).toBe(401);
  });

  it("missing token → 400", async () => {
    expect((await api().post("/api/auth/refresh").send({})).status).toBe(400);
  });
});

describe("POST /api/auth/logout", () => {
  it("invalidates the user's refresh tokens", async () => {
    const s = await customerViaOtp(api);
    const res = await api(s.token).post("/api/auth/logout");
    expect(res.status).toBe(200);
    expect((await api().post("/api/auth/refresh").send({ refreshToken: s.refreshToken })).status).toBe(401);
  });

  it("requires a token", async () => {
    expect((await api().post("/api/auth/logout")).status).toBe(401);
  });
});

describe("password forgot / reset (admins only)", () => {
  const forgot = (email) => api().post("/api/auth/password/forgot").send({ email });
  const reset = (token, password) => api().post("/api/auth/password/reset").send({ token, password });
  const tokenFromLastEmail = () => {
    const calls = mocks().resendSend.mock.calls;
    const html = calls[calls.length - 1][0].html;
    return html.match(/reset-password\?token=([0-9a-f]{64})/)[1];
  };

  it("unknown, customer and admin addresses get the identical generic answer", async () => {
    const { user } = await makeAdmin();
    await makeCustomer({ email: "cust@shop.test" });
    const a = await forgot(user.email);
    const b = await forgot("nobody@shop.test");
    const c = await forgot("cust@shop.test");
    expect(a.status).toBe(200);
    expect(a.body).toEqual(b.body);
    expect(a.body).toEqual(c.body);
    expect(mocks().resendSend).toHaveBeenCalledTimes(1);
  });

  it("stores only a hash, valid for 45 minutes, and emails the raw token", async () => {
    const { user } = await makeAdmin();
    await forgot(user.email);
    const raw = tokenFromLastEmail();
    const rec = await PasswordResetToken.findOne({ userId: user._id }).lean();
    expect(rec.tokenHash).toBe(crypto.createHash("sha256").update(raw).digest("hex"));
    const ttl = rec.expiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(44 * 60_000);
    expect(ttl).toBeLessThanOrEqual(45 * 60_000);
  });

  it("reset changes the password, burns the token, and ends sessions", async () => {
    const { user } = await makeAdmin();
    const login = await api().post("/api/auth/login").send({ email: user.email, password: ADMIN_PASSWORD });
    await forgot(user.email);
    const raw = tokenFromLastEmail();
    expect((await reset(raw, "BrandNewPass!1")).status).toBe(200);
    expect((await api().post("/api/auth/login").send({ email: user.email, password: ADMIN_PASSWORD })).status).toBe(401);
    expect((await api().post("/api/auth/login").send({ email: user.email, password: "BrandNewPass!1" })).status).toBe(200);
    expect((await api().post("/api/auth/refresh").send({ refreshToken: login.body.refreshToken })).status).toBe(401);
    // Single use.
    expect((await reset(raw, "AnotherPass!22")).status).toBe(400);
  });

  it("expired token → 400", async () => {
    const { user } = await makeAdmin();
    await forgot(user.email);
    const raw = tokenFromLastEmail();
    await PasswordResetToken.updateMany({}, { expiresAt: new Date(Date.now() - 1000) });
    expect((await reset(raw, "BrandNewPass!1")).status).toBe(400);
  });

  it("requesting a new link invalidates the previous one", async () => {
    const { user } = await makeAdmin();
    await forgot(user.email);
    const first = tokenFromLastEmail();
    await forgot(user.email);
    const second = tokenFromLastEmail();
    expect((await reset(first, "BrandNewPass!1")).status).toBe(400);
    expect((await reset(second, "BrandNewPass!1")).status).toBe(200);
  });

  it("short password, missing fields and forged token → 400", async () => {
    const { user } = await makeAdmin();
    await forgot(user.email);
    const raw = tokenFromLastEmail();
    expect((await reset(raw, "short")).status).toBe(400);
    expect((await reset(undefined, "LongEnough!1")).status).toBe(400);
    expect((await reset("a".repeat(64), "LongEnough!1")).status).toBe(400);
    expect((await forgot("")).status).toBe(400);
  });

  it("mail provider failure → 502 so the admin is not left waiting", async () => {
    const { user } = await makeAdmin();
    mocks().resendSend.mockResolvedValueOnce({ data: null, error: { message: "down" } });
    expect((await forgot(user.email)).status).toBe(502);
  });

  it("a token issued for an account later demoted to USER is refused", async () => {
    const { user } = await makeAdmin();
    await forgot(user.email);
    const raw = tokenFromLastEmail();
    await User.updateOne({ _id: user._id }, { role: "USER" });
    expect((await reset(raw, "BrandNewPass!1")).status).toBe(400);
  });
});

describe("PATCH /api/users/me/password", () => {
  it("admin can change their own password with the current one", async () => {
    const { user, token } = await makeAdmin();
    const res = await api(token).patch("/api/users/me/password").send({ currentPassword: ADMIN_PASSWORD, newPassword: "Another!Pass1" });
    expect(res.status).toBe(200);
    expect((await api().post("/api/auth/login").send({ email: user.email, password: "Another!Pass1" })).status).toBe(200);
  });

  it("wrong current password → 401; OTP customer → 400; short → 400", async () => {
    const { token } = await makeAdmin();
    expect((await api(token).patch("/api/users/me/password").send({ currentPassword: "x", newPassword: "Another!Pass1" })).status).toBe(401);
    expect((await api(token).patch("/api/users/me/password").send({ currentPassword: ADMIN_PASSWORD, newPassword: "12" })).status).toBe(400);
    const c = await makeCustomer();
    expect((await api(c.token).patch("/api/users/me/password").send({ currentPassword: "x", newPassword: "Another!Pass1" })).status).toBe(400);
  });

  it("token for a deleted user → 404", async () => {
    const { user } = await makeAdmin();
    const t = tokenFor(user);
    await User.deleteMany({});
    expect((await api(t).patch("/api/users/me/password").send({ currentPassword: "x", newPassword: "Another!Pass1" })).status).toBe(404);
  });
});
