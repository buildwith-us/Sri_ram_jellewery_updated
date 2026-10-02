import { Product } from "../models/Product.js";
import { Order } from "../models/Order.js";

/**
 * How long an unpaid card order may hold its stock before the sweeper takes it
 * back. Razorpay checkout sessions do not stay open indefinitely, so 30 minutes
 * comfortably covers a payment genuinely in progress without holding a piece
 * hostage for hours after the customer walked away.
 *
 * Tunable without a redeploy — the shop may want it shorter during a rush.
 */
export const STOCK_RELEASE_MINUTES = Number(process.env.STOCK_RELEASE_MINUTES) || 30;

export const EXPIRY_REASON = "Payment was not completed in time — reservation released automatically.";

/**
 * Stock reservation for orders.
 *
 * WHEN STOCK IS TAKEN: at order creation, for both payment methods — not at
 * payment confirmation. Two reasons.
 *
 * 1. A COD order has no payment-confirmation step at all; `POST /api/orders` is
 *    the only write in that flow. Reserving at confirmation would leave every
 *    COD order decrementing nothing.
 * 2. Much of this catalogue is one-off pieces. Selling the same piece twice
 *    means telling a customer who has already paid that their piece is gone,
 *    which is far worse than briefly holding a piece for a checkout that is
 *    later abandoned.
 *
 * The cost is real and deliberate: a card order that is created but never paid
 * holds its stock until something releases it. Cancellation and owner rejection
 * both release (see releaseStock). What is NOT yet covered is an order that is
 * simply abandoned at the Razorpay screen — that needs a sweeper for unpaid
 * pending orders older than N minutes, which is not in this change.
 *
 * Note that `stock: 0` blocks ordering. The product page already treats 0 as
 * out of stock, so this only makes the server agree with what the customer is
 * already being shown.
 */

/**
 * Resolve the same way the order routes do — by Mongo _id or by the
 * human-readable productId — so a release can find the product an order item
 * refers to, whichever form was stored on the line.
 */
const productFilter = (productId) => ({
  $or: [
    { _id: /^[0-9a-fA-F]{24}$/.test(String(productId)) ? productId : null },
    { productId },
  ].filter(Boolean),
});

/**
 * Atomically take stock for every line, all or nothing.
 *
 * Each decrement is conditional on there still being enough (`$gte: quantity`),
 * so two orders racing for the last piece cannot both succeed — the second
 * update matches no document. If any line fails, lines already taken are put
 * back before returning, so a partial reservation is never left behind.
 *
 * @param {Array<{productId: string, quantity: number, name?: string}>} items
 * @returns {Promise<{ok: true} | {ok: false, product: string, available: number}>}
 */
export const reserveStock = async (items) => {
  const taken = [];

  for (const item of items) {
    const quantity = item.quantity || 1;

    const updated = await Product.findOneAndUpdate(
      { ...productFilter(item.productId), stock: { $gte: quantity } },
      { $inc: { stock: -quantity } },
      { new: true }
    );

    if (!updated) {
      // Put back whatever this attempt already took, then report which line
      // failed and what is actually left.
      await releaseStock(taken);
      const current = await Product.findOne(productFilter(item.productId))
        .select("name stock")
        .lean();
      return {
        ok: false,
        product: item.name || current?.name || "This piece",
        available: current?.stock ?? 0,
      };
    }

    taken.push({ productId: item.productId, quantity });
  }

  return { ok: true };
};

/**
 * Return stock taken by an order — used when an order is cancelled or rejected,
 * and to roll back a partial reservation.
 */
export const releaseStock = async (items) => {
  for (const item of items) {
    await Product.updateOne(productFilter(item.productId), {
      $inc: { stock: item.quantity || 1 },
    });
  }
};

/**
 * Release stock held by card orders that were created but never paid for.
 *
 * Closes the gap left by reserving at order creation: a customer who reaches
 * the Razorpay screen and closes it leaves a reservation behind that nothing
 * else clears. Cancellation and rejection are both deliberate acts; this is the
 * case where nobody acts at all.
 *
 * COD is deliberately never swept. An unpaid COD order is not an abandoned
 * checkout — it is a real commitment that is *supposed* to sit unpaid until
 * delivery. Two independent guards keep it out: paymentStatus "pending" is the
 * online-payment state (COD writes "unpaid"), and paymentMethod is excluded
 * explicitly as well.
 *
 * Each order is claimed with a conditional update before its stock goes back.
 * Claiming first means a crash mid-sweep leaks a reservation, which someone can
 * see and fix; releasing first would risk restocking the same order twice and
 * overselling — the failure that actually costs a customer their piece.
 */
export const releaseStaleReservations = async ({ windowMinutes, now = Date.now() } = {}) => {
  const minutes = Number(windowMinutes) || STOCK_RELEASE_MINUTES;
  const cutoff = new Date(now - minutes * 60 * 1000);

  const stale = await Order.find({
    stockReserved: true,
    paidAt: null,
    paymentStatus: "pending",
    // Case-insensitive: orders written before paymentMethod was normalised can
    // hold "COD" or " Cod ", and no spelling of cash on delivery is swept.
    paymentMethod: { $not: /^\s*cod\s*$/i },
    createdAt: { $lt: cutoff },
  })
    .select("_id orderId items totalAmount createdAt")
    .lean();

  const released = [];

  for (const order of stale) {
    // Claim it. If a webhook confirmed the payment a moment ago, or another
    // sweep already took it, this matches nothing and we leave it alone.
    const claimed = await Order.findOneAndUpdate(
      { _id: order._id, stockReserved: true, paidAt: null },
      {
        stockReserved: false,
        orderStatus: "expired",
        paymentStatus: "expired",
        expiredAt: new Date(now),
        cancellationReason: EXPIRY_REASON,
      },
      { new: true }
    );

    if (!claimed) continue;

    await releaseStock(order.items);

    const ageMinutes = Math.round((now - new Date(order.createdAt).getTime()) / 60000);
    // Structured enough to grep. Repeated abandonment of one product is worth
    // noticing — it can mean a broken checkout rather than ordinary drop-off.
    console.log(
      `🧹 Reservation expired: ${order.orderId} (${ageMinutes}m old, ` +
        `₹${Number(order.totalAmount || 0).toLocaleString("en-IN")}) — restocked ` +
        order.items.map((i) => `${i.productId}×${i.quantity || 1}`).join(", ")
    );

    released.push({
      orderId: order.orderId,
      ageMinutes,
      items: order.items.map((i) => ({ productId: i.productId, quantity: i.quantity || 1 })),
    });
  }

  return { scanned: stale.length, released, windowMinutes: minutes };
};

/**
 * Customer-facing wording for a refused line. Deliberately does not promise a
 * restock date the shop has not committed to.
 */
export const outOfStockMessage = ({ product, available }) =>
  available > 0
    ? `${product} is no longer available in that quantity — only ${available} left. Please adjust your order.`
    : `${product} has just sold out and is no longer available. Please remove it from your order.`;
