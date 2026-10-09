import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { normalizeEmail } from "../utils/emailIdentity.js";

/**
 * The OTP limiters' bucket: the normalised sign-in address, the same key the
 * account and its code use. Keying on the raw body let each spelling of one
 * identity have its own allowance (bug S4 — the phone limiters gave
 * "9876543210" and "+91 98765 43210" separate buckets). Anything that does
 * not normalise shares one bucket; the route rejects it anyway.
 */
const otpBucket = (req) => {
  const n = normalizeEmail(req.body?.email);
  return n.ok ? `email:${n.key}` : "invalid-email";
};

/**
 * Locally every request arrives from the same loopback IP, so ordinary testing
 * (or an automated script) burns through the auth allowance and locks the
 * developer out of their own admin panel for 15 minutes. Production keeps full
 * brute-force protection.
 */
const skipInDevelopment = () => process.env.NODE_ENV === "development";

/**
 * Rate limiter for auth endpoints — prevent brute force attacks.
 * 10 attempts per 15 minutes per IP.
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: { error: "Too many attempts. Please try again in 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInDevelopment,
});

/**
 * Token refresh: its own bucket, 60 per 15 minutes per IP.
 *
 * It used to share authLimiter with login, so ten failed sign-ins from one IP
 * — an office, a household, a mobile carrier's shared address — blocked every
 * customer behind that IP from refreshing, which signs them out (bug B10).
 * Refresh needs a valid single-use token, so it is not a guessing surface; the
 * cap only bounds abuse. 60 leaves room for several shoppers on one connection,
 * each refreshing once per 30-minute access token.
 */
export const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: { error: "Too many session refreshes. Please try again in a few minutes." },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInDevelopment,
});

/**
 * General API rate limiter.
 * 200 requests per minute per IP.
 */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 200,
  message: { error: "Too many requests. Please slow down." },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Rate limiter for unauthenticated public forms (contact, newsletter).
 * These write to the database without a JWT, so without a cap a single client
 * can flood the admin inbox and the subscriber list.
 * 5 submissions per 15 minutes per IP.
 */
export const publicFormLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  message: { error: "Too many submissions. Please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInDevelopment,
});

/**
 * Rate limiter for sign-in code requests: 10 per 5 minutes per address.
 */
export const otpLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 10,
  message: { error: "Too many OTP requests. Please wait before trying again." },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: otpBucket,
  skip: skipInDevelopment,
});

/**
 * Rate limiter for code verification — throttles brute-force guessing of the
 * 6-digit code: 5 per 5 minutes per address.
 */
export const otpVerifyLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 5,
  message: { error: "Too many OTP verification attempts. Please request a new OTP." },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: otpBucket,
  skip: skipInDevelopment,
});

/**
 * Cap on how many DIFFERENT addresses one IP may have sign-in codes sent to:
 * 10 per rolling hour (bug B9).
 *
 * otpLimiter caps requests per address, which does nothing against one client
 * cycling through thousands of addresses — and every code is an email that
 * costs quota (a hit daily cap means nobody can sign in) and lands in a
 * stranger's inbox. Repeat requests for an address already counted are free
 * here; otpLimiter handles those.
 *
 * In memory, per instance, like the other limiters. 10 rather than lower
 * because many customers can share one IP (offices, mobile carriers).
 */
export const OTP_RECIPIENTS_PER_IP = 10;
const OTP_RECIPIENT_WINDOW_MS = 60 * 60 * 1000;
const recipientsByIp = new Map(); // ip bucket -> Map(emailKey -> first seen ms)

export const otpRecipientLimiter = (req, res, next) => {
  if (skipInDevelopment()) return next();
  const n = normalizeEmail(req.body?.email);
  if (!n.ok) return next(); // the route rejects it; nothing will be sent

  const now = Date.now();
  const ip = ipKeyGenerator(req.ip || "unknown");
  const seen = recipientsByIp.get(ip) || new Map();
  for (const [key, at] of seen) if (now - at >= OTP_RECIPIENT_WINDOW_MS) seen.delete(key);

  if (!seen.has(n.key) && seen.size >= OTP_RECIPIENTS_PER_IP) {
    const oldest = Math.min(...seen.values());
    res.set("Retry-After", String(Math.ceil((oldest + OTP_RECIPIENT_WINDOW_MS - now) / 1000)));
    return res.status(429).json({
      error: "Too many different email addresses from this connection. Please try again later.",
    });
  }

  seen.set(n.key, seen.get(n.key) ?? now);
  recipientsByIp.set(ip, seen);

  // Keep the map bounded: drop IPs whose entries have all expired.
  if (recipientsByIp.size > 10_000) {
    for (const [k, m] of recipientsByIp) {
      if ([...m.values()].every((at) => now - at >= OTP_RECIPIENT_WINDOW_MS)) recipientsByIp.delete(k);
    }
  }
  next();
};
