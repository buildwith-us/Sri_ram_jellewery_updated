import { z } from "zod";

/**
 * Canonical email identity for customer sign-in. The server's answer, decided
 * in exactly one place.
 *
 * A customer's email is the key of their account, of their sign-in code and of
 * the rate-limit bucket that throttles both. If those three disagreed about
 * what "the same address" means, one person could hold two accounts, or get a
 * fresh rate-limit allowance per spelling — which is exactly how the phone
 * limiters were bypassed (bug S4: "9876543210", "+91 98765 43210" and
 * "09876543210" each got their own bucket). Every caller uses this helper;
 * nothing normalises inline.
 *
 * Rules:
 *   - trim and lowercase the whole address
 *   - gmail.com and googlemail.com are one mailbox system: the domain becomes
 *     gmail.com, dots in the local part are ignored, and "+anything" is an
 *     alias of the same inbox, so it is dropped
 *   - other providers keep dots and "+" — they are significant elsewhere
 *
 * The address as typed is kept separately for display and for sending.
 */

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);
const emailShape = z.email();

/**
 * The account key for an address, without validating it. Used to compare
 * against stored addresses that predate validation (the seeded admin is
 * "admin@buildwithus", which has no TLD). Returns null when there is no "@".
 */
export const canonicalEmailKey = (raw) => {
  if (typeof raw !== "string") return null;
  const lowered = raw.trim().toLowerCase();
  const at = lowered.lastIndexOf("@");
  if (at <= 0 || at === lowered.length - 1) return null;
  let local = lowered.slice(0, at);
  let domain = lowered.slice(at + 1);
  if (GMAIL_DOMAINS.has(domain)) {
    domain = "gmail.com";
    local = local.split("+")[0].replace(/\./g, "");
    if (!local) return null;
  }
  return `${local}@${domain}`;
};

/**
 * Validate and normalise a sign-in address.
 *
 * @returns {{ ok: true, key: string, display: string } | { ok: false, reason: string }}
 *   key     — account / OTP / rate-limit key
 *   display — the address as the customer typed it, trimmed
 */
export const normalizeEmail = (input) => {
  if (input === undefined || input === null || (typeof input === "string" && !input.trim())) {
    return { ok: false, reason: "Email address is required" };
  }
  if (typeof input !== "string") {
    return { ok: false, reason: "Enter a valid email address" };
  }
  const display = input.trim();
  if (display.length > 254 || !emailShape.safeParse(display).success) {
    return { ok: false, reason: "Enter a valid email address" };
  }
  const key = canonicalEmailKey(display);
  if (!key) return { ok: false, reason: "Enter a valid email address" };
  return { ok: true, key, display };
};

export default normalizeEmail;
