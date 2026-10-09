/**
 * Prove the email transport works end to end.
 *
 *   node server/scripts/testEmail.js you@example.com
 *
 * With RESEND_API_KEY and EMAIL_FROM set it sends a real message and prints the
 * provider's id. In development without them it prints the message instead
 * (console mode). Anywhere else without them it fails, exactly as sign-in
 * codes would — see "Before going live" in README.md.
 *
 * EMAIL_FROM must be on a domain verified in Resend (never a gmail.com or other
 * webmail address).
 */

import dotenv from "dotenv";
import { sendEmail, isEmailLive, renderEmailLayout, emailButton } from "../utils/email.js";

dotenv.config();

const to = process.argv[2];

if (!to) {
  console.error("Usage: node server/scripts/testEmail.js <recipient@example.com>");
  process.exit(1);
}

const run = async () => {
  console.log(`Mode: ${isEmailLive() ? "LIVE — a real email will be sent" : "DRY RUN — nothing will be sent"}`);
  console.log(`From: ${process.env.EMAIL_FROM || "(default onboarding@resend.dev)"}`);
  console.log(`To:   ${to}\n`);

  const result = await sendEmail({
    to,
    subject: "Sri Ram Jewellery — email transport test",
    tag: "transport-test",
    html: renderEmailLayout({
      heading: "Email transport is working",
      intro:
        "If you are reading this, the transactional email setup is configured correctly. " +
        "This message was sent by <code>server/scripts/testEmail.js</code> and confirms the " +
        "API key, sender address and provider connection are all valid.",
      bodyHtml: emailButton("https://sriramjewellery.in", "Visit the shop"),
      footerNote:
        "This is a one-off test triggered from the command line. Nothing is scheduled and no customer received it.",
    }),
  });

  console.log("\nResult:", JSON.stringify(result, null, 2));

  if (!result.ok) {
    console.error("\n❌ Send failed. Check RESEND_API_KEY and that EMAIL_FROM uses a verified domain.");
    process.exit(1);
  }

  console.log(
    result.console
      ? "\n✅ Printed to the console (development, no provider configured). Set RESEND_API_KEY and EMAIL_FROM to send for real."
      : `\n✅ Sent. Provider message id: ${result.id}`
  );
};

run().catch((err) => {
  console.error("Unexpected failure:", err);
  process.exit(1);
});
