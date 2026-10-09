import { CANONICAL_PHONE } from "./phone.js";

/**
 * Whether a customer has given us what the shop needs to fulfil an order:
 * a name to address them by, and a phone the owner can call about delivery.
 * The email is not on the list — signing in with a code already verified it.
 *
 * The phone counts only in its saved form, an Indian mobile as +91XXXXXXXXXX
 * (what PATCH /api/users/me writes). A number stored before normalisation is
 * asked for again, so saving it once puts it in that form.
 *
 * The server decides this, so the sign-in modal, /login and anything else ask
 * the same question and get the same answer.
 *
 * @returns {{ profileComplete: boolean, missing: Array<"name"|"phone"> }}
 */
export const profileStatus = (user) => {
  const missing = [];
  if (!String(user?.name ?? "").trim()) missing.push("name");
  if (!CANONICAL_PHONE.test(String(user?.phone ?? ""))) missing.push("phone");
  return { profileComplete: missing.length === 0, missing };
};

export default profileStatus;
