/**
 * Transactional email. One module, one place that knows how mail is sent.
 *
 * Everything else calls `sendMail()` (or `sendEmail()` for the HTML reset
 * mail) and never touches a provider SDK. The provider is an adapter in
 * PROVIDERS below; swapping Resend for another service is a change here alone.
 *
 * Configuration (env, never hardcoded):
 *   EMAIL_PROVIDER   adapter name, default "resend"
 *   RESEND_API_KEY   the Resend key
 *   EMAIL_FROM       e.g. "Sri Ram Jewellery <orders@sriramjewellery.in>".
 *                    Must be on the shop's own domain — never a free webmail
 *                    address, which fails the receiving side's DMARC checks.
 *   EMAIL_REPLY_TO   optional
 *   EMAIL_DRY_RUN    "true" logs instead of sending — development only
 *
 * ── Three modes ───────────────────────────────────────────────────────────
 *   live        provider configured → mail is sent. A provider error (bad
 *               key, unverified domain, daily quota hit) is reported as a
 *               failure, never as success, and logged loudly with the
 *               provider's reason.
 *   console     not configured AND NODE_ENV=development → the message,
 *               including any sign-in code, is printed to the server console
 *               so the flow can be exercised before a provider exists.
 *   unavailable not configured anywhere else (production, preview, test) →
 *               nothing is sent and every call fails. Logged as FATAL at
 *               startup. The console mode is unreachable here: a preview
 *               runs with NODE_ENV=production and must not print sign-in
 *               codes into a log anyone with dashboard access can read.
 *
 * Like a missing JWT_SECRET, a missing email config does NOT crash the
 * server — product pages keep working; only what needs email fails closed.
 *
 * Failures never throw. Callers decide whether a failure matters.
 */

import { Resend } from "resend";
import dotenv from "dotenv";
dotenv.config();

// ─── Provider adapters ───────────────────────────────────────────────────────

const PROVIDERS = {
  resend: {
    label: "Resend",
    isConfigured: () => Boolean(process.env.RESEND_API_KEY),
    send: async ({ from, to, subject, text, html, replyTo }) => {
      const client = new Resend(process.env.RESEND_API_KEY);
      const { data, error } = await client.emails.send({ from, to, subject, text, html, replyTo });
      if (error) {
        // Resend reports failures (including quota) in the payload, not by throwing.
        const reason = [error.statusCode, error.name, error.message].filter(Boolean).join(" ");
        return { ok: false, error: reason || String(error) };
      }
      return { ok: true, id: data?.id };
    },
  },
};

const providerKey = () => (process.env.EMAIL_PROVIDER || "resend").trim().toLowerCase();

// Sending as a webmail address from our servers fails that domain's DMARC, so
// the mail is junked or dropped. The sender must be the shop's own domain.
const WEBMAIL = /@(gmail|googlemail|yahoo|ymail|outlook|hotmail|live|msn|icloud|me|aol|proton|protonmail|rediffmail)\.[a-z.]+>?\s*$/i;

const isDevelopment = () => process.env.NODE_ENV === "development";

/**
 * Current mode and, when not live, why. Read on every call so a config
 * change (or a test) takes effect without a restart.
 *
 * @returns {{ mode: "live"|"console"|"unavailable", problems: string[], provider: string|null }}
 */
export const emailConfig = () => {
  const provider = PROVIDERS[providerKey()];
  const from = process.env.EMAIL_FROM?.trim();
  const problems = [];

  if (!provider) problems.push(`EMAIL_PROVIDER "${providerKey()}" is not supported`);
  else if (!provider.isConfigured()) problems.push(`${provider.label} API key is not set`);
  if (!from) problems.push("EMAIL_FROM is not set");
  else if (WEBMAIL.test(from)) problems.push(`EMAIL_FROM (${from}) must be on the shop's own domain, not a webmail address`);

  const forcedDryRun = isDevelopment() && process.env.EMAIL_DRY_RUN === "true";
  let mode = "unavailable";
  if (problems.length === 0 && !forcedDryRun) mode = "live";
  else if (isDevelopment()) mode = "console";

  return { mode, problems, provider: provider?.label ?? null };
};

/** True when mail will actually leave the building. */
export const isEmailLive = () => emailConfig().mode === "live";

/** True when email-dependent features (sign-in codes) can work at all. */
export const canDeliverEmail = () => emailConfig().mode !== "unavailable";

// Say so at startup. An unconfigured sender means nobody can sign in, so it
// must be impossible to miss in the deploy log.
{
  const { mode, problems } = emailConfig();
  if (mode === "unavailable") {
    console.error(
      "FATAL: email is not configured — " +
        problems.join("; ") +
        ". Sign-in codes cannot be sent: /api/auth/otp/request will return 503 until this is fixed."
    );
  } else if (mode === "console") {
    console.warn(
      `✉️  Email is in CONSOLE mode (development): messages, including sign-in codes, are printed here, not sent.` +
        (problems.length ? ` (${problems.join("; ")})` : "")
    );
  }
}

// ─── Sending ─────────────────────────────────────────────────────────────────

/**
 * Strip tags for the plain-text alternative of an HTML message.
 */
const toPlainText = (html) =>
  String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/**
 * Send one email. The single entry point for every message the app sends.
 *
 * @param {object} opts
 * @param {string|string[]} opts.to
 * @param {string} opts.subject
 * @param {string} opts.text     plain-text body (always required)
 * @param {string} [opts.html]   optional HTML alternative
 * @param {string} [opts.replyTo]
 * @param {string} [opts.tag]    short label for the logs, e.g. "sign-in-code"
 * @returns {Promise<{ ok: boolean, id?: string, console?: boolean, unavailable?: boolean, error?: string }>}
 */
export const sendMail = async ({ to, subject, text, html, replyTo, tag = "email" }) => {
  if (!to || !subject || !text) {
    return { ok: false, error: "sendMail requires to, subject and text" };
  }

  const recipients = Array.isArray(to) ? to : [to];
  const { mode, problems, provider } = emailConfig();

  if (mode === "unavailable") {
    console.error(`FATAL: ${tag} NOT sent to ${recipients.join(", ")} — email is not configured (${problems.join("; ")}).`);
    return { ok: false, unavailable: true, error: "Email is not configured" };
  }

  if (mode === "console") {
    console.log(
      `\n── ✉️  [console — development only] ${tag} ─────────────────\n` +
        `To:      ${recipients.join(", ")}\n` +
        `Subject: ${subject}\n\n` +
        `${text}\n` +
        "──────────────────────────────────────────────────────\n"
    );
    return { ok: true, console: true };
  }

  try {
    const result = await PROVIDERS[providerKey()].send({
      from: process.env.EMAIL_FROM.trim(),
      to: recipients,
      subject,
      text,
      html,
      replyTo: replyTo || process.env.EMAIL_REPLY_TO || undefined,
    });
    if (!result.ok) {
      console.error(
        `🚨 EMAIL SEND FAILED — ${tag} to ${recipients.join(", ")} via ${provider}: ${result.error}. ` +
          "If this is a quota error, nobody can sign in until the quota resets or the plan is raised."
      );
      return { ok: false, error: result.error };
    }
    console.log(`✉️  ${tag} sent to ${recipients.join(", ")} via ${provider} (id ${result.id})`);
    return { ok: true, id: result.id };
  } catch (err) {
    // Network failure, provider outage. Never rethrow.
    console.error(`🚨 EMAIL SEND FAILED — ${tag} to ${recipients.join(", ")} via ${provider}: ${err.message}`);
    return { ok: false, error: err.message };
  }
};

/**
 * HTML message (the administrator password reset). A thin wrapper so it goes
 * through exactly the same modes and failure handling as sendMail.
 */
export const sendEmail = ({ to, subject, html, text, replyTo, tag = "email" }) => {
  if (!html) return Promise.resolve({ ok: false, error: "sendEmail requires to, subject and html" });
  return sendMail({ to, subject, text: text || toPlainText(html), html, replyTo, tag });
};

/**
 * Shared shell so every HTML message looks like it came from the same shop.
 * Inline styles only — email clients discard <style> blocks.
 */
export const renderEmailLayout = ({ heading, intro, bodyHtml = "", footerNote }) => `
<div style="margin:0;padding:0;background:#fff8f2;font-family:Helvetica,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:40px 24px;">
    <p style="margin:0 0 28px;font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#8b6447;">
      Sri Ram Jewellery
    </p>
    <h1 style="margin:0 0 16px;font-size:26px;line-height:1.25;color:#1c1714;font-weight:600;">
      ${heading}
    </h1>
    <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#5e534a;">
      ${intro}
    </p>
    ${bodyHtml}
    ${
      footerNote
        ? `<p style="margin:32px 0 0;padding-top:20px;border-top:1px solid #e6ddd2;font-size:13px;line-height:1.6;color:#8d8279;">${footerNote}</p>`
        : ""
    }
  </div>
</div>`;

/** Primary button. Table-wrapped because Outlook ignores padding on <a>. */
export const emailButton = (href, label) => `
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 8px;">
  <tr>
    <td style="background:#8b6447;border-radius:2px;">
      <a href="${href}" style="display:inline-block;padding:14px 28px;font-size:13px;letter-spacing:0.12em;text-transform:uppercase;color:#ffffff;text-decoration:none;font-weight:600;">
        ${label}
      </a>
    </td>
  </tr>
</table>`;

export default sendMail;
