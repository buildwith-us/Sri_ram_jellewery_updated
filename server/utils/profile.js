/**
 * Whether a customer has given us what the shop needs to fulfil an order:
 * a name to address them by, and a phone the owner can call about delivery.
 * The email is not on the list — signing in with a code already verified it.
 *
 * The server decides this, so the sign-in modal, /login and anything else ask
 * the same question and get the same answer.
 *
 * @returns {{ profileComplete: boolean, missing: Array<"name"|"phone"> }}
 */
export const profileStatus = (user) => {
  const missing = [];
  if (!String(user?.name ?? "").trim()) missing.push("name");
  if (!String(user?.phone ?? "").trim()) missing.push("phone");
  return { profileComplete: missing.length === 0, missing };
};

export default profileStatus;
