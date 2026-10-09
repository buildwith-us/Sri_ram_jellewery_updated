import { describe, it, expect, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { useApp, mocks } from "../helpers/app.js";
import {
  uniqueEmail,
  uniquePhone,
  customerViaOtp,
  lastCodeSentTo,
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

const requestOtp = (email) => api().post("/api/auth/otp/request").send({ email });
const verifyOtp = (email, otp) => api().post("/api/auth/otp/verify").send({ email, otp });
const sentCount = () => mocks().resendSend.mock.calls.length;
const decode = (token) => jwt.decode(token);

describe("POST /api/auth/otp/request (email)", () => {
  it("creates a USER keyed by the normalised address, stores the address as typed, emails a 5-minute code", async () => {
    const typed = `  Asha.${process.pid}@Example.COM `;
    const key = typed.trim().toLowerCase();
    const res = await requestOtp(typed);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, message: "OTP sent successfully" });

    const u = await User.findOne({ emailKey: key }).lean();
    expect(u.role).toBe("USER");
    expect(u.email).toBe(typed.trim());
    expect(u.otpHash).toMatch(/^\$2[aby]\$/);
    const ttl = u.otpExpiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(4.5 * 60_000);
    expect(ttl).toBeLessThanOrEqual(5 * 60_000);

    const mail = mocks().resendSend.mock.calls.at(-1)[0];
    expect(mail.to).toEqual([typed.trim()]);
    expect(mail.subject).toMatch(/Sri Ram Jewellery/);
    expect(mail.text).toMatch(/Sri Ram Jewellery sign-in code is \d{6}/);
    expect(mail.text).toMatch(/expires in 5 minutes/);
    expect(mail.text).toMatch(/did not try to sign in, ignore this email/);
    expect(mail.html).toBeUndefined();
    expect(await bcrypt.compare(lastCodeSentTo(typed.trim()), u.otpHash)).toBe(true);
  });

  it("dots, +aliases, case and whitespace on gmail.com / googlemail.com all reach ONE account", async () => {
    const spellings = [
      `asha.raman.${process.pid}@gmail.com`,
      ` AshaRaman${process.pid}+offers@GMAIL.com `,
      `a.s.h.a.raman${process.pid}+x@googlemail.com`,
    ];
    for (const s of spellings) expect((await requestOtp(s)).status).toBe(200);
    const accounts = await User.find({ emailKey: { $exists: true } }).lean();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].emailKey).toBe(`asharaman${process.pid}@gmail.com`);
    // The latest code, requested under one spelling, verifies under another.
    const otp = lastCodeSentTo(spellings[2].trim());
    const res = await verifyOtp(`ASHA.RAMAN.${process.pid}@gmail.com`, otp);
    expect(res.status).toBe(200);
    expect(res.body.user._id).toBe(String(accounts[0]._id));
  });

  it("other providers keep dots and +tags: they are different mailboxes", async () => {
    await requestOtp("a.b@shop.in");
    await requestOtp("ab@shop.in");
    await requestOtp("ab+x@shop.in");
    expect(await User.countDocuments({ emailKey: { $exists: true } })).toBe(3);
  });

  it.each([["not-an-email"], ["a@b"], [""], ["   "], [undefined], [12345], ["x".repeat(250) + "@a.com"]])(
    "invalid address %s → 400, nothing stored or sent",
    async (email) => {
      const res = await requestOtp(email);
      expect(res.status).toBe(400);
      expect(res.body.error).toBeTruthy();
      expect(await User.countDocuments()).toBe(0);
      expect(sentCount()).toBe(0);
    }
  );

  it("unknown and known addresses get the identical reply", async () => {
    const known = await makeCustomer();
    const a = await requestOtp(known.user.email);
    const b = await requestOtp(uniqueEmail("stranger"));
    expect(a.status).toBe(200);
    expect(b.status).toBe(a.status);
    expect(b.body).toEqual(a.body);
  });

  it("an administrator's address: identical reply, nothing stored, nothing sent", async () => {
    const admin = await makeAdmin({ email: "owner.name@gmail.com" });
    const normal = await requestOtp(uniqueEmail());
    const before = sentCount();
    // Every spelling that normalises to the admin's mailbox.
    for (const s of ["owner.name@gmail.com", "OwnerName+shop@googlemail.com", " o.w.n.e.r.n.a.m.e@gmail.com "]) {
      const res = await requestOtp(s);
      expect(res.status).toBe(normal.status);
      expect(res.body).toEqual(normal.body);
    }
    expect(sentCount()).toBe(before);
    expect(await User.countDocuments({ emailKey: "ownername@gmail.com" })).toBe(0);
    const after = await User.findById(admin.user._id).lean();
    expect(after.otpHash).toBeUndefined();
    expect(after.emailKey).toBeUndefined();
  });

  it("the TLD-less seeded admin address is refused as an invalid address, never a code", async () => {
    await makeAdmin({ email: "admin@buildwithus" });
    expect((await requestOtp("admin@buildwithus")).status).toBe(400);
    expect(sentCount()).toBe(0);
  });

  it("a record keyed by emailKey that is not a customer gets the standard reply and no code", async () => {
    const email = uniqueEmail("promoted");
    await User.create({ email, emailKey: email, role: "ADMIN", name: "Promoted" });
    const res = await requestOtp(email);
    expect(res.body).toEqual({ success: true, message: "OTP sent successfully" });
    expect(sentCount()).toBe(0);
    expect((await User.findOne({ emailKey: email }).lean()).otpHash).toBeUndefined();
  });

  it("email unavailable (no provider, not development) → 503, nothing stored", async () => {
    setEnv("RESEND_API_KEY", undefined);
    const res = await requestOtp(uniqueEmail());
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/try again/i);
    expect(await User.countDocuments()).toBe(0);
  });

  it("provider rejection (e.g. quota) → 503, never success, and the unsent code is cleared", async () => {
    mocks().resendSend.mockResolvedValueOnce({
      data: null,
      error: { statusCode: 429, name: "daily_quota_exceeded", message: "quota" },
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const email = uniqueEmail();
    const res = await requestOtp(email);
    expect(res.status).toBe(503);
    expect(res.body.success).toBeUndefined();
    expect((await User.findOne({ emailKey: email }).lean()).otpHash).toBeUndefined();
    expect(spy.mock.calls.flat().join(" ")).toMatch(/EMAIL SEND FAILED/);
  });

  it("provider throws (network) → 503", async () => {
    mocks().resendSend.mockRejectedValueOnce(new Error("ECONNRESET"));
    expect((await requestOtp(uniqueEmail())).status).toBe(503);
  });

  it("console mode (development, no provider): 200, the code is printed, and it verifies", async () => {
    setEnv("NODE_ENV", "development");
    setEnv("RESEND_API_KEY", undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const email = uniqueEmail();
    expect((await requestOtp(email)).status).toBe(200);
    expect(mocks().resendSend).not.toHaveBeenCalled();
    const code = log.mock.calls.flat().join("\n").match(/sign-in code is (\d{6})/)?.[1];
    expect(code).toMatch(/^\d{6}$/);
    expect((await verifyOtp(email, code)).status).toBe(200);
  });
});

describe("test OTP (ALLOW_TEST_OTP + TEST_OTP_EMAILS)", () => {
  it("an allowlisted address gets the fixed code and nothing is emailed", async () => {
    const email = uniqueEmail("demo");
    setEnv("TEST_OTP_EMAILS", `someone@else.in, ${email.toUpperCase()}`);
    expect((await requestOtp(email)).status).toBe(200);
    expect(sentCount()).toBe(0);
    expect((await verifyOtp(email, "123456")).status).toBe(200);
  });

  it("allowlist entries are normalised like sign-in (gmail dots and +tags)", async () => {
    setEnv("TEST_OTP_EMAILS", "demo.phone@gmail.com");
    expect((await requestOtp("DemoPhone+qa@googlemail.com")).status).toBe(200);
    expect(sentCount()).toBe(0);
    expect((await verifyOtp("demophone@gmail.com", "123456")).status).toBe(200);
  });

  it("an address OFF the allowlist is refused the fixed code (a real code is emailed instead)", async () => {
    setEnv("TEST_OTP_EMAILS", "demo@shop.in");
    const email = uniqueEmail();
    expect((await requestOtp(email)).status).toBe(200);
    expect(sentCount()).toBe(1);
    const res = await verifyOtp(email, "123456");
    if (lastCodeSentTo(email) !== "123456") expect(res.status).toBe(401);
  });

  it("an empty allowlist means the fixed code works for NO address", async () => {
    setEnv("TEST_OTP_EMAILS", undefined);
    const email = uniqueEmail();
    await requestOtp(email);
    expect(sentCount()).toBe(1);
    if (lastCodeSentTo(email) !== "123456") expect((await verifyOtp(email, "123456")).status).toBe(401);
  });

  it.each([["TRUE"], [""], ["false"], ["1"], [undefined]])("ALLOW_TEST_OTP=%s leaves the bypass off", async (value) => {
    const email = uniqueEmail("demo");
    setEnv("TEST_OTP_EMAILS", email);
    setEnv("ALLOW_TEST_OTP", value);
    await requestOtp(email);
    expect(sentCount()).toBe(1); // a real code was emailed
  });

  it.each([["NODE_ENV"], ["VERCEL_ENV"]])("%s=production disables the bypass even for an allowlisted address", async (k) => {
    const email = uniqueEmail("demo");
    setEnv("TEST_OTP_EMAILS", email);
    setEnv(k, "production");
    await requestOtp(email);
    expect(sentCount()).toBe(1);
    if (lastCodeSentTo(email) !== "123456") expect((await verifyOtp(email, "123456")).status).toBe(401);
  });

  it("the bypass needs no email provider for an allowlisted address", async () => {
    const email = uniqueEmail("demo");
    setEnv("TEST_OTP_EMAILS", email);
    setEnv("RESEND_API_KEY", undefined);
    expect((await requestOtp(email)).status).toBe(200);
  });
});

describe("POST /api/auth/otp/verify (email)", () => {
  it("new address: tokens, USER role, code cleared, profile incomplete (name and phone missing)", async () => {
    const email = uniqueEmail();
    await requestOtp(email);
    const res = await verifyOtp(email.toUpperCase(), lastCodeSentTo(email));
    expect(res.status).toBe(200);
    expect(res.body.refreshToken).toMatch(/^[0-9a-f]{80}$/);
    expect(res.body.user).toMatchObject({ email, role: "USER" });
    expect(res.body.profileComplete).toBe(false);
    expect(res.body.missing).toEqual(["name", "phone"]);
    const u = await User.findOne({ emailKey: email }).lean();
    expect(u.otpHash).toBeUndefined();
    const stored = await RefreshToken.findOne({ userId: u._id }).lean();
    expect(stored.tokenHash).toBe(crypto.createHash("sha256").update(res.body.refreshToken).digest("hex"));
    expect(decode(res.body.accessToken)).toMatchObject({ role: "USER", email });
  });

  it("returning customer with name and phone: profileComplete true, nothing missing", async () => {
    const { user } = await makeCustomer();
    await requestOtp(user.email);
    const res = await verifyOtp(user.email, lastCodeSentTo(user.email));
    expect(res.body).toMatchObject({ profileComplete: true, missing: [] });
    expect(res.body.user).toMatchObject({ name: "Test Customer", phone: user.phone });
  });

  it("name present, phone missing → missing ['phone']", async () => {
    const { user } = await makeCustomer({ phone: undefined });
    await requestOtp(user.email);
    expect((await verifyOtp(user.email, lastCodeSentTo(user.email))).body.missing).toEqual(["phone"]);
  });

  it("a phone stored before normalisation (or not a mobile) still counts as missing", async () => {
    for (const phone of ["9876543210", "+91 98765 43210", "+914422334455", "   "]) {
      const { user } = await makeCustomer({ phone });
      await requestOtp(user.email);
      expect((await verifyOtp(user.email, lastCodeSentTo(user.email))).body.missing, phone).toEqual(["phone"]);
    }
  });

  it("the access token works on a protected route, and /users/me reports profile status", async () => {
    const s = await customerViaOtp(api);
    const me = await api(s.token).get("/api/users/me");
    expect(me.status).toBe(200);
    expect(me.body.data).toMatchObject({ profileComplete: false, missing: ["name", "phone"] });
  });

  it("wrong code → 401", async () => {
    const email = uniqueEmail();
    await requestOtp(email);
    const wrong = lastCodeSentTo(email) === "000000" ? "111111" : "000000";
    const res = await verifyOtp(email, wrong);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid OTP");
  });

  it("expired code → 401", async () => {
    const email = uniqueEmail();
    await requestOtp(email);
    await User.updateOne({ emailKey: email }, { otpExpiresAt: new Date(Date.now() - 1000) });
    const res = await verifyOtp(email, lastCodeSentTo(email));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("OTP has expired");
  });

  it("a code is single use", async () => {
    const email = uniqueEmail();
    await requestOtp(email);
    const code = lastCodeSentTo(email);
    expect((await verifyOtp(email, code)).status).toBe(200);
    expect((await verifyOtp(email, code)).status).toBe(401);
  });

  it("a new request replaces the previous code", async () => {
    const email = uniqueEmail();
    await requestOtp(email);
    const first = lastCodeSentTo(email);
    await requestOtp(email);
    const second = lastCodeSentTo(email);
    if (first !== second) expect((await verifyOtp(email, first)).status).toBe(401);
    expect((await verifyOtp(email, second)).status).toBe(200);
  });

  it("no prior request → 401; unknown and known-without-code give the same reply", async () => {
    const { user } = await makeCustomer();
    const a = await verifyOtp(uniqueEmail(), "123456");
    const b = await verifyOtp(user.email, "123456");
    expect(a.status).toBe(401);
    expect(b.body).toEqual(a.body);
  });

  it("missing code or bad address → 400", async () => {
    expect((await api().post("/api/auth/otp/verify").send({ email: uniqueEmail() })).status).toBe(400);
    expect((await verifyOtp("nope", "123456")).status).toBe(400);
  });
});

describe("an email code can NEVER mint an ADMIN token", () => {
  const plantedCode = async (fields) => {
    const otpHash = await bcrypt.hash("654321", 4);
    return User.create({ otpHash, otpExpiresAt: new Date(Date.now() + 60_000), ...fields });
  };

  it("a record with emailKey and role ADMIN (e.g. written directly) is refused, no token", async () => {
    const email = uniqueEmail("staff");
    await plantedCode({ email, emailKey: email, role: "ADMIN" });
    const res = await verifyOtp(email, "654321");
    expect(res.status).toBe(401);
    expect(res.body.accessToken).toBeUndefined();
  });

  it("a customer record switched to ADMIN between request and verify is refused", async () => {
    const email = uniqueEmail();
    await requestOtp(email);
    await User.updateOne({ emailKey: email }, { role: "ADMIN" });
    const res = await verifyOtp(email, lastCodeSentTo(email));
    expect(res.status).toBe(401);
    expect(res.body.accessToken).toBeUndefined();
  });

  it("a USER record whose key is an administrator's address is refused", async () => {
    await makeAdmin({ email: "owner@shop.in" });
    await plantedCode({ emailKey: "owner@shop.in", role: "USER" });
    expect((await verifyOtp("owner@shop.in", "654321")).status).toBe(401);
  });

  it("every successful verify issues role USER, and the token passes no admin route", async () => {
    const s = await customerViaOtp(api);
    expect(decode(s.accessToken).role).toBe("USER");
    expect(s.user.role).toBe("USER");
    expect((await api(s.token).get("/api/users")).status).toBe(403);
  });

  it("a code-signed-in customer later switched to ADMIN cannot refresh into an admin session", async () => {
    const s = await customerViaOtp(api);
    await User.updateOne({ _id: s.user._id }, { role: "ADMIN" });
    const res = await api().post("/api/auth/refresh").send({ refreshToken: s.refreshToken });
    expect(res.status).toBe(401);
    expect(res.body.accessToken).toBeUndefined();
  });

  it("administrators still sign in with email + password (unchanged)", async () => {
    const { user } = await makeAdmin();
    const res = await api().post("/api/auth/login").send({ email: user.email, password: ADMIN_PASSWORD });
    expect(res.status).toBe(200);
    expect(decode(res.body.accessToken).role).toBe("ADMIN");
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
    const email = uniqueEmail();
    const a = await customerViaOtp(api, email);
    const b = await customerViaOtp(api, email);
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
