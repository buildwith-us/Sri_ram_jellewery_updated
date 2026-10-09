import { Counter } from "../models/Counter.js";

/**
 * Order numbers the owner can read out over the phone: SRJ-20261009-0007.
 *
 * The date is the shop's own day (India time), and the counter restarts at
 * 0001 each day, padded to four digits (a 10,000th order in a day simply gets
 * five). The counter is one atomic $inc, so simultaneous orders cannot share a
 * number — the old `ORD-${Date.now()}` gave two orders in the same
 * millisecond the same id, and under a burst 40–70% of orders failed (S6).
 * Existing ORD-… numbers are left as they are.
 */
export const ORDER_ID_PATTERN = /^SRJ-\d{8}-\d{4,}$/;

const shopDay = (now) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(now)
    .replace(/-/g, "");

export const nextOrderId = async (now = new Date()) => {
  const day = shopDay(now);
  const { seq } = await Counter.findOneAndUpdate(
    { _id: `order:${day}` },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();
  return `SRJ-${day}-${String(seq).padStart(4, "0")}`;
};

/** Mongo's duplicate-key error on Order.orderId. */
export const isOrderIdClash = (error) => error?.code === 11000 && Boolean(error?.keyPattern?.orderId);

/** How many fresh numbers to try before giving up on a clash. */
export const ORDER_ID_ATTEMPTS = 5;
