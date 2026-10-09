import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { User } from "../models/User.js";
import { RefreshToken } from "../models/RefreshToken.js";
import { PasswordResetToken } from "../models/PasswordResetToken.js";
import { sendMail, sendEmail, renderEmailLayout, emailButton, canDeliverEmail } from "../utils/email.js";
import { verifyJWT, JWT_SECRET } from "../middleware/auth.js";
import { otpLimiter, otpVerifyLimiter, authLimiter } from "../middleware/rateLimit.js";
import { normalizeEmail, canonicalEmailKey } from "../utils/emailIdentity.js";
import { profileStatus } from "../utils/profile.js";
// These schemas already existed in middleware/validate.js but were wired to
// nothing — every auth route hand-rolled its own checks.
import { validate, registerSchema } from "../middleware/validate.js";
import dotenv from "dotenv";
dotenv.config();

const router = express.Router();

// Fail closed on every auth route if the signing secret is missing, rather than
// throwing at import time and crashing the entire API.
router.use((req, res, next) => {
  if (!JWT_SECRET) {
    return res.status(503).json({ error: "Authentication is not configured on this server" });
  }
  next();
});

const ACCESS_TOKEN_EXPIRY = "30m";
const REFRESH_TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days in ms
const BCRYPT_SALT_ROUNDS = 12;

// Long enough to find the email and act on it, short enough that a link left in
// an inbox is not a standing key to the admin dashboard.
const PASSWORD_RESET_EXPIRY_MS = 45 * 60 * 1000; // 45 minutes

// How long a sign-in code stays valid.
const OTP_EXPIRY_MINUTES = 5;

// The one reply /otp/request gives for every address it accepts — known,
// unknown, or an administrator's. Differing replies would let anyone probe
// which addresses have accounts, and which belong to the shop's staff.
const OTP_SENT = { success: true, message: "OTP sent successfully" };

// ─── Test OTP ────────────────────────────────────────────────────────────────
//
// A fixed code for named test addresses, so a preview can be demonstrated
// without a mailbox. Fails CLOSED on every axis:
//   - only the exact string ALLOW_TEST_OTP="true" turns it on;
//   - never in a production environment (VERCEL_ENV or NODE_ENV production),
//     whatever the flag says;
//   - only for addresses listed in TEST_OTP_EMAILS. An empty or missing list
//     means NO address gets the fixed code. ("123456 for any address" would
//     be a free login to every account on any build where the flag is on.)
const TEST_OTP = "123456";

const isProductionEnv = () =>
  process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";

const isTestOtpEnabled = () => process.env.ALLOW_TEST_OTP === "true" && !isProductionEnv();

/** Allowlisted addresses, normalised exactly as sign-in normalises them. */
const testOtpEmails = () =>
  (process.env.TEST_OTP_EMAILS || "")
    .split(",")
    .map((s) => canonicalEmailKey(s))
    .filter(Boolean);

const isTestOtpAllowedFor = (emailKey) => isTestOtpEnabled() && testOtpEmails().includes(emailKey);

// Announce the bypass at startup so it cannot be left on unnoticed.
if (isTestOtpEnabled()) {
  const list = testOtpEmails();
  console.warn(
    "\n" +
      "══════════════════════════════════════════════════════════════\n" +
      "⚠️  TEST SIGN-IN CODE ACTIVE — ALLOW_TEST_OTP=true\n" +
      (list.length
        ? `    The fixed code ${TEST_OTP} is accepted for: ${list.join(", ")}\n`
        : "    TEST_OTP_EMAILS is empty, so the fixed code works for NO address.\n") +
      `    Environment: VERCEL_ENV=${process.env.VERCEL_ENV || "unset"} NODE_ENV=${process.env.NODE_ENV || "unset"}\n` +
      "══════════════════════════════════════════════════════════════\n"
  );
} else if (process.env.ALLOW_TEST_OTP === "true") {
  console.warn(
    "⚠️  ALLOW_TEST_OTP=true was set but is REFUSED in a production environment " +
      `(VERCEL_ENV=${process.env.VERCEL_ENV || "unset"}, NODE_ENV=${process.env.NODE_ENV || "unset"}).`
  );
}

// ─── Tokens ──────────────────────────────────────────────────────────────────

/**
 * Generate an access token (short-lived JWT). `role` defaults to the record's;
 * the email-code path passes "USER" explicitly so a customer token can never
 * carry anything else, whatever the record says.
 */
const generateAccessToken = (user, { role = user.role } = {}) => {
  return jwt.sign(
    {
      userId: user._id.toString(),
      role,
      email: user.email || user.emailKey || null,
      phone: user.phone || null,
      name: user.name || null,
    },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRY }
  );
};

/**
 * Generate a refresh token and store its hash in MongoDB.
 * Returns the raw refresh token to send to the client.
 */
const generateRefreshToken = async (userId, role) => {
  // Generate a random token
  const rawToken = crypto.randomBytes(40).toString("hex");

  // Hash it before storing (PRD: refresh tokens stored hashed, not raw)
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_MS);

  // Single-session enforcement, scoped by role.
  //
  // For ADMIN it is a deliberate security posture: one live administrative
  // session, so a leaked token cannot quietly coexist with the real operator.
  //
  // For customers it was collateral damage. Shopping on a phone silently ended
  // the session on the laptop, which reads as the site logging you out at
  // random — and it is entirely normal to browse on one device and check out on
  // another. Customers keep concurrent sessions; expiry still bounds them.
  if (role === "ADMIN") {
    await RefreshToken.deleteMany({ userId });
  }

  // Store hashed token
  await RefreshToken.create({
    userId,
    tokenHash,
    expiresAt,
  });

  return rawToken;
};

/**
 * Is this normalised address an administrator's? Compared by canonical key,
 * so "Owner.Name+x@gmail.com" cannot slip past an exact-string check for an
 * admin registered as "ownername@gmail.com". There are a handful of admins, so
 * reading them all is cheap and needs no extra index.
 */
const isAdminAddress = async (emailKey) => {
  const admins = await User.find({ role: "ADMIN" }).select("email").lean();
  return admins.some((a) => canonicalEmailKey(a.email) === emailKey);
};

const otpEmailText = (code) =>
  `Your Sri Ram Jewellery sign-in code is ${code}.\n\n` +
  `It expires in ${OTP_EXPIRY_MINUTES} minutes and can be used once.\n\n` +
  "If you did not try to sign in, ignore this email. Nobody can sign in without this code.\n\n" +
  "— Sri Ram Jewellery";

// ─── POST /api/auth/otp/request ──────────────────────────────────────────────
//
// Customers sign in with their email address. Administrators never do: they
// use email + password at /api/auth/login, and nothing on this path can reach
// their accounts (see isAdminAddress, the emailKey lookup, and the hard-coded
// USER role in /otp/verify).
router.post("/otp/request", otpLimiter, async (req, res) => {
  try {
    const normalized = normalizeEmail(req.body?.email);
    if (!normalized.ok) {
      return res.status(400).json({ error: normalized.reason });
    }
    const { key: emailKey, display } = normalized;

    const testOtp = isTestOtpAllowedFor(emailKey);

    // No way to deliver a code: refuse rather than store one nobody receives.
    if (!testOtp && !canDeliverEmail()) {
      console.error("FATAL: sign-in code requested but email is not configured — returning 503.");
      return res.status(503).json({
        error: "Sign-in codes can't be sent right now. Please try again shortly.",
      });
    }

    // An administrator's address gets the standard reply with nothing stored
    // and nothing sent.
    if (await isAdminAddress(emailKey)) {
      console.warn(`Refused sign-in code for an administrator address (${emailKey}) — admins use password sign-in.`);
      return res.json(OTP_SENT);
    }

    let user = await User.findOne({ emailKey });

    // Defence in depth: a record found by emailKey must be a customer.
    if (user && user.role !== "USER") {
      console.warn(`Refused sign-in code for a non-customer record ${user._id}.`);
      return res.json(OTP_SENT);
    }

    const otp = testOtp ? TEST_OTP : crypto.randomInt(100000, 1000000).toString();

    if (!user) {
      user = new User({ emailKey, role: "USER" });
      // The display address is stored only when no other record holds that
      // exact string (a legacy customer may have typed it as an unverified
      // contact address). The account is keyed by emailKey either way.
      if (!(await User.exists({ email: display }))) user.email = display;
    }
    const otpHash = await bcrypt.hash(otp, BCRYPT_SALT_ROUNDS);
    const otpExpiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);
    user.otpHash = otpHash;
    user.otpExpiresAt = otpExpiresAt;
    try {
      await user.save();
    } catch (saveError) {
      // Two first requests for the same new address raced and the unique
      // emailKey index let only one create the account. Use the winner's.
      if (saveError?.code !== 11000) throw saveError;
      user = await User.findOne({ emailKey });
      if (!user || user.role !== "USER") return res.json(OTP_SENT);
      user.otpHash = otpHash;
      user.otpExpiresAt = otpExpiresAt;
      await user.save();
    }

    if (testOtp) {
      console.warn(`⚠️  [TEST OTP] fixed code issued for allowlisted ${emailKey} — nothing emailed.`);
      return res.json(OTP_SENT);
    }

    const sent = await sendMail({
      to: display,
      subject: "Your Sri Ram Jewellery sign-in code",
      text: otpEmailText(otp),
      tag: "sign-in-code",
    });

    if (!sent.ok) {
      // Never report success for a code that did not leave. The provider's
      // reason is already logged loudly by sendMail. The stored code is
      // cleared so it cannot outlive a delivery that never happened.
      user.otpHash = undefined;
      user.otpExpiresAt = undefined;
      await user.save();
      return res.status(503).json({
        error: "We couldn't send your sign-in code just now. Please try again in a few minutes.",
      });
    }

    res.json(OTP_SENT);
  } catch (error) {
    console.error("OTP Request error:", error);
    res.status(500).json({ error: "Failed to send OTP" });
  }
});

// ─── POST /api/auth/otp/verify ───────────────────────────────────────────────
router.post("/otp/verify", otpVerifyLimiter, async (req, res) => {
  try {
    const { otp } = req.body || {};

    // Normalised identically to /otp/request — the lookup is by emailKey.
    const normalized = normalizeEmail(req.body?.email);
    if (!normalized.ok || !otp) {
      return res.status(400).json({ error: "Email address and OTP are required" });
    }
    const { key: emailKey } = normalized;

    const invalid = () => res.status(401).json({ error: "Invalid OTP or email address" });

    const user = await User.findOne({ emailKey });
    if (!user || !user.otpHash || !user.otpExpiresAt) return invalid();

    // Only customer records may be signed in with a code — never an
    // administrator, whether by role on the record or by address.
    if (user.role !== "USER" || (await isAdminAddress(emailKey))) {
      console.warn(`Refused code verification for a non-customer record ${user._id}.`);
      return invalid();
    }

    if (Date.now() > user.otpExpiresAt.getTime()) {
      return res.status(401).json({ error: "OTP has expired" });
    }

    const isMatch = await bcrypt.compare(String(otp), user.otpHash);
    if (!isMatch) {
      return res.status(401).json({ error: "Invalid OTP" });
    }

    // Single use: clear before issuing anything.
    user.otpHash = undefined;
    user.otpExpiresAt = undefined;
    await user.save();

    // Hard-coded: an email code can only ever produce a customer session.
    const accessToken = generateAccessToken(user, { role: "USER" });
    const refreshToken = await generateRefreshToken(user._id, "USER");

    res.json({
      success: true,
      accessToken,
      refreshToken,
      user: {
        _id: user._id,
        name: user.name,
        email: user.email || user.emailKey,
        phone: user.phone,
        role: "USER",
      },
      ...profileStatus(user),
    });
  } catch (error) {
    console.error("OTP Verify error:", error);
    res.status(500).json({ error: "Failed to verify OTP" });
  }
});

// ─── POST /api/auth/register ──────────────────────────────────────────────────
//
// DISABLED. No frontend component calls this — customers are created by the OTP
// flow, and administrators are seeded. An unreachable endpoint that mints
// credentialled accounts is attack surface with no corresponding feature.
//
// It was never an escalation risk: the handler destructures only
// { name, email, password } and hardcodes role: "USER", so a `role: "ADMIN"` in
// the body was always ignored. The regression tested for below keeps it that
// way if the route is ever re-enabled.
//
// To re-enable for internal tooling: delete the guard, and keep both the zod
// `validate(registerSchema)` middleware and the explicit role assignment.
const REGISTRATION_ENABLED = process.env.ALLOW_EMAIL_REGISTRATION === "true";

router.post("/register", authLimiter, validate(registerSchema), async (req, res) => {
  if (!REGISTRATION_ENABLED) {
    return res.status(404).json({ error: "Not found" });
  }

  try {
    // Destructuring — not `...req.body` — is what makes a `role` in the request
    // body inert. Never spread request bodies into User.create() here.
    const { name, email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(409).json({ error: "An account with this email already exists" });
    }

    // Hash password with bcrypt
    const passwordHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);

    // Create user
    const user = await User.create({
      name: name || email.split("@")[0],
      email: email.toLowerCase(),
      passwordHash,
      role: "USER",
    });

    // Issue tokens
    const accessToken = generateAccessToken(user);
    const refreshToken = await generateRefreshToken(user._id, user.role);

    res.status(201).json({
      success: true,
      accessToken,
      refreshToken,
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("Register error:", error);
    res.status(500).json({ error: "Registration failed" });
  }
});

// ─── POST /api/auth/login ─────────────────────────────────────────────────────
// Deliberately NOT wrapped in validate(loginSchema). Sign-in is a lookup, not a
// creation: enforcing strict email syntax here cannot improve security (the
// bcrypt compare is the gate) and can only lock out accounts that already
// exist. The seeded administrator is exactly that case — "admin@buildwithus"
// has no TLD, so z.email() rejects it and the only admin account could no
// longer sign in. Format validation belongs on account creation.
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    // Find user by email
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    if (!user.passwordHash) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    // Verify password
    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    // Issue tokens
    const accessToken = generateAccessToken(user);
    const refreshToken = await generateRefreshToken(user._id, user.role);

    res.json({
      success: true,
      accessToken,
      refreshToken,
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        photoURL: user.photoURL,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Login failed" });
  }
});

// ─── POST /api/auth/refresh ───────────────────────────────────────────────────
router.post("/refresh", async (req, res) => {
  try {
    const { refreshToken: rawToken } = req.body;

    if (!rawToken) {
      return res.status(400).json({ error: "Refresh token required" });
    }

    // Hash the incoming token to compare against stored hash
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

    // Find the stored refresh token
    const storedToken = await RefreshToken.findOne({ tokenHash });
    if (!storedToken) {
      // Unknown hash. Deliberately NOT treated as reuse: an unrecognised token
      // names no user, so there is no family to revoke — and if a bare 401 here
      // triggered a revocation, anyone could sign every customer out by posting
      // random strings. Genuine replay is caught by the spent-token branch
      // below, which does know whose session to end.
      return res.status(401).json({ error: "Invalid refresh token" });
    }

    // Reuse detection. This token was already exchanged, so the legitimate
    // client is holding its replacement — whoever is presenting this one copied
    // it. We cannot tell attacker from victim, so end every session for the
    // account and make them sign in again.
    if (storedToken.usedAt) {
      await RefreshToken.deleteMany({ userId: storedToken.userId });
      console.warn(
        `🔐 Refresh token reuse detected for user ${storedToken.userId} ` +
          `(token first spent at ${storedToken.usedAt.toISOString()}). Revoked all sessions.`
      );
      return res.status(401).json({
        error: "This session has been ended for your security. Please sign in again.",
      });
    }

    // Check expiry
    if (storedToken.expiresAt < new Date()) {
      await RefreshToken.deleteOne({ _id: storedToken._id });
      return res.status(401).json({ error: "Refresh token expired" });
    }

    // Find the user
    const user = await User.findById(storedToken.userId);
    if (!user) {
      await RefreshToken.deleteOne({ _id: storedToken._id });
      return res.status(401).json({ error: "User not found" });
    }

    // An administrator session can only belong to an account that signs in
    // with a password. A record that was switched to ADMIN without one (an
    // email-code customer) must not be refreshed into an admin token.
    if (user.role === "ADMIN" && !user.passwordHash) {
      await RefreshToken.deleteMany({ userId: user._id });
      console.warn(`Refused refresh: ADMIN record ${user._id} has no password.`);
      return res.status(401).json({ error: "Invalid refresh token" });
    }

    // Spend this token before minting its replacement. Conditional on usedAt
    // still being null so that two concurrent refreshes with the same token
    // cannot both succeed — the loser is treated as reuse on its next attempt.
    const spent = await RefreshToken.findOneAndUpdate(
      { _id: storedToken._id, usedAt: null },
      { usedAt: new Date() },
      { new: true }
    );
    if (!spent) {
      return res.status(401).json({ error: "Invalid refresh token" });
    }

    // Issue new access token (rotate refresh token for extra security)
    const newAccessToken = generateAccessToken(user);
    const newRefreshToken = await generateRefreshToken(user._id, user.role);

    res.json({
      success: true,
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        photoURL: user.photoURL,
      },
    });
  } catch (error) {
    console.error("Refresh error:", error);
    res.status(500).json({ error: "Token refresh failed" });
  }
});

// ─── POST /api/auth/logout ────────────────────────────────────────────────────
router.post("/logout", verifyJWT, async (req, res) => {
  try {
    // Invalidate all refresh tokens for this user (immediate logout per PRD)
    await RefreshToken.deleteMany({ userId: req.user.userId });

    res.json({ success: true, message: "Logged out successfully" });
  } catch (error) {
    console.error("Logout error:", error);
    res.status(500).json({ error: "Logout failed" });
  }
});

// ─── POST /api/auth/password/forgot ──────────────────────────────────────────
//
// Password sign-in exists only for administrators, so this is the administrator
// recovery path. Customers authenticate by OTP and have no password to reset.
router.post("/password/forgot", authLimiter, async (req, res) => {
  // Always the same answer, whatever happens below. Telling a caller that an
  // address is unknown turns this endpoint into a way to enumerate which emails
  // are administrator accounts — the highest-value thing to know about this
  // system. Also returned when the address belongs to a customer.
  const genericResponse = {
    success: true,
    message: "If that email belongs to an administrator account, a reset link is on its way.",
  };

  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    const user = await User.findOne({ email });

    // Only administrators; only accounts that already had a password.
    if (!user || user.role !== "ADMIN" || !user.passwordHash) {
      console.warn(`Password reset requested for a non-eligible address (${email}).`);
      return res.json(genericResponse);
    }

    // One live reset at a time — requesting a new link invalidates the old one.
    await PasswordResetToken.deleteMany({ userId: user._id });

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

    await PasswordResetToken.create({
      userId: user._id,
      tokenHash,
      expiresAt: new Date(Date.now() + PASSWORD_RESET_EXPIRY_MS),
      requestedIp: req.ip,
      requestedUserAgent: req.headers["user-agent"] || null,
    });

    const base = (process.env.PUBLIC_SITE_URL || "http://localhost:5173").replace(/\/$/, "");
    const resetUrl = `${base}/reset-password?token=${rawToken}`;

    const result = await sendEmail({
      to: email,
      subject: "Reset your Sri Ram Jewellery administrator password",
      tag: "password-reset",
      html: renderEmailLayout({
        heading: "Reset your password",
        intro:
          "We received a request to reset the password for your administrator account. " +
          `This link is valid for ${PASSWORD_RESET_EXPIRY_MS / 60000} minutes and can be used once.`,
        bodyHtml:
          emailButton(resetUrl, "Choose a new password") +
          `<p style="margin:20px 0 0;font-size:13px;line-height:1.6;color:#8d8279;word-break:break-all;">
             If the button does not work, paste this into your browser:<br>${resetUrl}
           </p>`,
        footerNote:
          "If you did not request this, you can ignore this email — your password has not changed. " +
          "If you receive these repeatedly, someone may know your email address; consider changing it.",
      }),
    });

    if (!result.ok) {
      // The token exists but the link never left the building. Say so: unlike an
      // order confirmation, a silent failure here leaves the administrator
      // waiting indefinitely for an email that is not coming.
      console.error("Password reset email failed to send:", result.error);
      return res.status(502).json({
        error:
          "We could not send the reset email. Check the mail provider configuration, " +
          "or use the command-line recovery script.",
      });
    }

    if (result.console) {
      console.warn(
        `✉️  Email is in console mode (development) — the reset link was NOT emailed. Use it directly:\n   ${resetUrl}`
      );
    }

    return res.json(genericResponse);
  } catch (error) {
    console.error("Password forgot error:", error);
    return res.status(500).json({ error: "Could not process the reset request" });
  }
});

// ─── POST /api/auth/password/reset ───────────────────────────────────────────
router.post("/password/reset", authLimiter, async (req, res) => {
  try {
    const { token, password } = req.body || {};

    if (!token || !password) {
      return res.status(400).json({ error: "Reset token and new password are required" });
    }
    if (String(password).length < 8) {
      // Deliberately stricter than the 6 used elsewhere: this password is the
      // only thing standing between a stranger and the admin dashboard.
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    const tokenHash = crypto.createHash("sha256").update(String(token)).digest("hex");
    const record = await PasswordResetToken.findOne({ tokenHash });

    // One message for every failure mode — expired, spent, forged, unknown.
    const invalid = () =>
      res.status(400).json({ error: "This reset link is invalid or has expired. Request a new one." });

    if (!record) return invalid();
    if (record.usedAt) return invalid();
    if (record.expiresAt < new Date()) return invalid();

    const user = await User.findById(record.userId);
    if (!user || user.role !== "ADMIN") return invalid();

    user.passwordHash = await bcrypt.hash(String(password), BCRYPT_SALT_ROUNDS);
    await user.save();

    // Burn the token, then end every existing session. Whoever triggered this
    // reset may have been an intruder holding a live token; changing the
    // password while leaving their session alive achieves nothing.
    record.usedAt = new Date();
    await record.save();
    await RefreshToken.deleteMany({ userId: user._id });

    console.warn(`🔐 Administrator password reset completed for ${user.email}.`);

    return res.json({
      success: true,
      message: "Your password has been changed. Sign in with your new password.",
    });
  } catch (error) {
    console.error("Password reset error:", error);
    return res.status(500).json({ error: "Could not reset the password" });
  }
});

export default router;
