import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { User } from "../models/User.js";
import { RefreshToken } from "../models/RefreshToken.js";
import { PasswordResetToken } from "../models/PasswordResetToken.js";
import { sendEmail, renderEmailLayout, emailButton } from "../utils/email.js";
import { verifyJWT, JWT_SECRET } from "../middleware/auth.js";
import { otpLimiter, otpVerifyLimiter, authLimiter } from "../middleware/rateLimit.js";
import { normalizeIndianPhone } from "../utils/phone.js";
// These schemas already existed in middleware/validate.js but were wired to
// nothing — every auth route hand-rolled its own checks.
import { validate, registerSchema } from "../middleware/validate.js";
import axios from "axios";
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

// The fixed OTP that lets any caller sign in as any phone number. It exists so
// the app is usable while MSG91 is blocked on DLT registration, and it must
// stay off unless explicitly turned on.
const TEST_OTP = "123456";

// Fails CLOSED: only the exact string "true" enables it. A missing, empty or
// misspelt value — the realistic mistake of forgetting to set it on a server —
// leaves it off. Deliberately NOT keyed on NODE_ENV: the old code accepted the
// test OTP whenever MSG91 was unconfigured, which is exactly the production
// state, so production accepted 123456 for every number.
//
// Hard gate: even an explicit ALLOW_TEST_OTP=true cannot enable the bypass on
// Vercel's *production* environment. Vercel sets VERCEL_ENV to
// "production" | "preview" | "development", so a variable set at project level
// — which applies to every environment at once, the realistic way this ships
// enabled — is still refused in production while continuing to work on preview.
// This is the difference between a convention and a control.
const isProductionEnv = () =>
  process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";

const isTestOtpEnabled = () => {
  if (process.env.ALLOW_TEST_OTP !== "true") return false;
  if (isProductionEnv()) return false;
  return true;
};

/**
 * Optional allowlist, e.g. TEST_OTP_PHONES="9363750806,9876543210".
 *
 * Unset means the bypass applies to every number, which also means every
 * existing customer account can be signed into by anyone who knows the phone
 * number. Setting it confines the bypass to demo handsets, so a shared
 * preview link cannot be used to reach a real account.
 */
const testOtpPhones = () =>
  (process.env.TEST_OTP_PHONES || "")
    .split(",")
    .map((s) => s.trim().replace(/^\+?91/, ""))
    .filter(Boolean);

const isTestOtpAllowedFor = (phone) => {
  if (!isTestOtpEnabled()) return false;
  const allowed = testOtpPhones();
  if (!allowed.length) return true; // no allowlist configured — applies to all
  return allowed.includes(String(phone).trim().replace(/^\+?91/, ""));
};

const isSmsConfigured = () =>
  Boolean(process.env.MSG91_AUTH_KEY && process.env.MSG91_TEMPLATE_ID);

// Announce the bypass loudly at startup so an operator cannot leave it on by
// accident without seeing it in the logs.
if (isTestOtpEnabled()) {
  const scoped = testOtpPhones();
  console.warn(
    "\n" +
      "══════════════════════════════════════════════════════════════\n" +
      "⚠️  AUTHENTICATION BYPASS ACTIVE — ALLOW_TEST_OTP=true\n" +
      `    The fixed OTP ${TEST_OTP} is accepted for ${
        scoped.length ? `these numbers only: ${scoped.join(", ")}` : "ALL PHONE NUMBERS"
      }.\n` +
      `    Environment: VERCEL_ENV=${process.env.VERCEL_ENV || "unset"} ` +
      `NODE_ENV=${process.env.NODE_ENV || "unset"}\n` +
      (scoped.length
        ? ""
        : "    Anyone who knows a customer's number can sign in as them.\n" +
          "    Set TEST_OTP_PHONES to confine it, or unset ALLOW_TEST_OTP.\n") +
      "══════════════════════════════════════════════════════════════\n"
  );
} else if (process.env.ALLOW_TEST_OTP === "true") {
  // Asked for, refused. Say so loudly — otherwise someone sets the variable,
  // sees sign-in fail on production, and assumes the deploy is broken.
  console.warn(
    "⚠️  ALLOW_TEST_OTP=true was set but is REFUSED in a production environment " +
      `(VERCEL_ENV=${process.env.VERCEL_ENV || "unset"}, NODE_ENV=${process.env.NODE_ENV || "unset"}). ` +
      "The test OTP is disabled. Configure MSG91 for real delivery."
  );
}

/**
 * Generate an access token (short-lived JWT).
 */
const generateAccessToken = (user) => {
  return jwt.sign(
    { userId: user._id.toString(), role: user.role, email: user.email || null, phone: user.phone || null, name: user.name || null },
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

// ─── POST /api/auth/otp/request ──────────────────────────────────────────────
router.post("/otp/request", otpLimiter, async (req, res) => {
  try {
    // Normalise BEFORE anything touches the database. The client also
    // normalises for display, but the server no longer trusts it to: a request
    // arriving by any other path used to be stored verbatim, which is how one
    // real number became several accounts.
    const normalized = normalizeIndianPhone(req.body?.phone);
    if (!normalized.ok) {
      return res.status(400).json({ error: normalized.reason });
    }
    const phone = normalized.phone;

    const authKey = process.env.MSG91_AUTH_KEY;
    const templateId = process.env.MSG91_TEMPLATE_ID;
    const smsConfigured = isSmsConfigured();
    const testOtp = isTestOtpAllowedFor(phone);

    // Neither a real SMS channel nor the deliberate test bypass: there is no way
    // to deliver a code, so refuse rather than write an OTP nobody can receive.
    // The message reveals nothing about whether the number is registered.
    if (!smsConfigured && !testOtp) {
      return res.status(503).json({
        error: "OTP delivery is temporarily unavailable. Please try again later.",
      });
    }

    // Upsert user by phone
    let user = await User.findOne({ phone });

    // Admins sign in with email and password only. This path mints a token
    // carrying whatever role the record holds, so an admin with a phone number
    // set would otherwise be reachable by OTP — and by the test OTP whenever
    // that is enabled. Answer exactly as for any other number (no OTP is
    // stored, so nothing can be verified) rather than confirming the number
    // belongs to an administrator.
    if (user?.role === "ADMIN") {
      console.warn(`Refused OTP request for admin account (phone ${phone}) — admins use password sign-in.`);
      return res.json({ success: true, message: "OTP sent successfully" });
    }

    const otp = smsConfigured
      ? Math.floor(100000 + Math.random() * 900000).toString()
      : TEST_OTP;

    const otpHash = await bcrypt.hash(otp, BCRYPT_SALT_ROUNDS);
    const otpExpiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 mins

    if (!user) {
      user = new User({ phone, role: "USER" });
    }
    user.otpHash = otpHash;
    user.otpExpiresAt = otpExpiresAt;
    await user.save();

    if (smsConfigured) {
      try {
        // MSG91 wants the country code without a "+", and an unencoded "+" in a
        // query string decodes to a space — so passing the canonical form
        // directly would send MSG91 " 919363750806". Strip and encode.
        const msg91Mobile = encodeURIComponent(phone.replace(/^\+/, ""));
        await axios.post(
          `https://control.msg91.com/api/v5/otp?template_id=${templateId}&mobile=${msg91Mobile}&authkey=${authKey}&otp=${otp}`,
          {}
        );
      } catch (smsError) {
        console.error("MSG91 Error:", smsError?.response?.data || smsError.message);
        // The OTP is stored; if delivery failed the user simply cannot verify.
        // We do not fall back to the test code here.
      }
    } else {
      // Reached only when testOtp is on. Keep it visible in the logs.
      console.warn(
        `⚠️  [TEST OTP] MSG91 not configured — accepting fixed OTP for ${phone} because ALLOW_TEST_OTP=true.`
      );
    }

    res.json({ success: true, message: "OTP sent successfully" });
  } catch (error) {
    console.error("OTP Request error:", error);
    res.status(500).json({ error: "Failed to send OTP" });
  }
});

// ─── POST /api/auth/otp/verify ───────────────────────────────────────────────
router.post("/otp/verify", otpVerifyLimiter, async (req, res) => {
  try {
    const { otp } = req.body;

    // Must normalise here too, and identically. The lookup below is by phone,
    // so if request stores the canonical form and verify searches for the raw
    // one, no record is ever found and every sign-in fails with "invalid OTP".
    const normalized = normalizeIndianPhone(req.body?.phone);
    if (!normalized.ok || !otp) {
      return res.status(400).json({ error: "Phone number and OTP are required" });
    }
    const phone = normalized.phone;

    const user = await User.findOne({ phone });
    if (!user || !user.otpHash || !user.otpExpiresAt) {
      return res.status(401).json({ error: "Invalid OTP or phone number" });
    }

    // Second layer: even if a record somehow carries a valid OTP (set before
    // the account was promoted, or written directly), this path must never
    // issue an admin token. Same generic message — no confirmation of role.
    if (user.role === "ADMIN") {
      console.warn(`Refused OTP verification for admin account (phone ${phone}).`);
      return res.status(401).json({ error: "Invalid OTP or phone number" });
    }

    if (Date.now() > user.otpExpiresAt.getTime()) {
      return res.status(401).json({ error: "OTP has expired" });
    }

    const isMatch = await bcrypt.compare(otp, user.otpHash);
    if (!isMatch) {
      return res.status(401).json({ error: "Invalid OTP" });
    }

    // Success - clear OTP fields
    user.otpHash = undefined;
    user.otpExpiresAt = undefined;
    await user.save();

    const accessToken = generateAccessToken(user);
    const refreshToken = await generateRefreshToken(user._id, user.role);

    res.json({
      success: true,
      accessToken,
      refreshToken,
      user: {
        _id: user._id,
        name: user.name,
        phone: user.phone,
        email: user.email,
        role: user.role,
      },
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
