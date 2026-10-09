/**
 * The order lifecycle, as one table. Every admin status change and every
 * approval decision is checked here, so the rules cannot be half-applied in
 * one handler and missing from another.
 *
 * Two independent axes:
 *   orderStatus     pending (online, unpaid) → processing → shipped → delivered
 *                   plus the end states cancelled and expired
 *   approvalStatus  PENDING → APPROVED | REJECTED   (the owner's decision)
 *
 * Before this table, an expired or cancelled order could be approved and
 * shipped, a delivered one moved back to processing, a rejected one approved
 * (holding no stock, so the piece could sell twice), and an unpaid online
 * order approved for delivery.
 */

/** Statuses an admin may move an order to, from each status. */
export const ADMIN_STATUS_TRANSITIONS = {
  // An online order whose payment has not completed. The sweeper expires it;
  // the owner may cancel it sooner. It cannot be fulfilled — it is unpaid.
  pending: ["cancelled"],
  processing: ["shipped", "delivered", "cancelled"],
  // Once shipped the piece has left the shop: only delivery remains. Undoing
  // a shipment is a returns process, not a status change.
  shipped: ["delivered"],
  // End states.
  delivered: [],
  cancelled: [],
  expired: [],
};

/** Statuses an order may not reach until the owner has approved it. */
export const REQUIRES_APPROVAL = ["shipped", "delivered"];

const statusOf = (order) => String(order.orderStatus || "processing").toLowerCase();

/** Cash on delivery is paid at the door; an online order must have been paid. */
export const isPaymentSettled = (order) =>
  String(order.paymentMethod || "cod").toLowerCase() === "cod" || Boolean(order.paidAt);

const refuse = (error) => ({ ok: false, error });
const allow = { ok: true };

/**
 * May an admin move this order to `next`?
 * @returns {{ ok: true, noop?: true } | { ok: false, error: string }}
 */
export const checkStatusChange = (order, next) => {
  const current = statusOf(order);
  if (current === next) return { ok: true, noop: true };

  const allowed = ADMIN_STATUS_TRANSITIONS[current];
  if (!allowed) return refuse(`This order's status ("${current}") can't be changed here`);

  if (!allowed.includes(next)) {
    if (allowed.length === 0) return refuse(`This order is ${current} and can no longer be changed`);
    return refuse(`A ${current} order can't be marked ${next}`);
  }

  if (REQUIRES_APPROVAL.includes(next) && order.approvalStatus !== "APPROVED") {
    return refuse("Approve this order before marking it shipped or delivered");
  }
  return allow;
};

/** May the owner approve this order? */
export const checkApprove = (order) => {
  if (order.approvalStatus === "APPROVED") return refuse("This order is already approved");
  if (order.approvalStatus === "REJECTED") return refuse("A rejected order can't be approved — its pieces have been released");
  const current = statusOf(order);
  if (current !== "processing" && current !== "pending") {
    return refuse(`This order is ${current} and can't be approved`);
  }
  if (!isPaymentSettled(order)) return refuse("This order hasn't been paid yet, so it can't be approved");
  return allow;
};

/** May the owner reject this order? */
export const checkReject = (order) => {
  if (order.approvalStatus === "REJECTED") return refuse("This order is already rejected");
  if (order.approvalStatus === "APPROVED") return refuse("An approved order cannot be rejected");
  const current = statusOf(order);
  if (current !== "processing" && current !== "pending") {
    return refuse(`This order is ${current} and can't be rejected`);
  }
  return allow;
};
