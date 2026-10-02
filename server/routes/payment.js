import express from "express";
import crypto from "crypto";
import { Order } from "../models/Order.js";
import { Product } from "../models/Product.js";
import { computePrice } from "../utils/computePrice.js";
import { verifyJWT } from "../middleware/auth.js";
import { sendOrderAlert, sendRefundRequiredAlert } from "../utils/whatsapp.js";
import { getRateStatus, findUnpriceableMetalsForProducts, rateUnavailableMessage } from "../utils/getRates.js";
import { reserveStock, releaseStock, outOfStockMessage } from "../utils/stock.js";
import { validate, createPaymentOrderSchema } from "../middleware/validate.js";
import dotenv from "dotenv";
dotenv.config();

const router = express.Router();

import Razorpay from "razorpay";

// Lazy-load Razorpay to avoid crashes if not installed or keys missing
let razorpayInstance = null;
const getRazorpay = () => {
  if (!razorpayInstance) {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) {
      return null;
    }
    try {
      razorpayInstance = new Razorpay({ key_id: keyId, key_secret: keySecret });
    } catch (e) {
      console.error("Failed to initialize Razorpay:", e);
      return null;
    }
  }
  return razorpayInstance;
};

// POST /api/payment/create-order — create a Razorpay order with server-verified price
router.post("/create-order", verifyJWT, validate(createPaymentOrderSchema), async (req, res) => {
  try {
    const razorpay = getRazorpay();
    if (!razorpay) {
      return res.status(503).json({
        error: "Payment system not configured. Please set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.",
      });
    }

    const { items, shippingAddress, name } = req.body;

    if (!items || !items.length) {
      return res.status(400).json({ error: "Order must contain at least one item" });
    }


    // Refuse rather than price against a rate that cannot be trusted: a stale
    // one yields a confident, wrong number (how ₹96/gram gold reached
    // checkout), and a missing one leaves nothing to price from at all.
    const { rateMap, staleMetals } = await getRateStatus();
    const affected = findUnpriceableMetalsForProducts(
      await Product.find({
        $or: items.map((i) => ({
          $or: [
            { _id: i.productId?.match(/^[0-9a-fA-F]{24}$/) ? i.productId : null },
            { productId: i.productId },
          ].filter(Boolean),
        })).flat(),
      }).lean(),
      { rateMap, staleMetals }
    );
    if (affected.length) {
      return res.status(503).json({ error: rateUnavailableMessage(affected) });
    }

    // Server-side price verification
    // — priced from the same rates just checked.
    let totalAmount = 0;
    let gstAmount = 0;
    const verifiedItems = [];

    for (const item of items) {
      const product = await Product.findOne({
        $or: [
          { _id: item.productId?.match(/^[0-9a-fA-F]{24}$/) ? item.productId : null },
          { productId: item.productId }
        ].filter(Boolean)
      }).lean();

      if (!product) {
        return res.status(400).json({ error: `Product not found: ${item.productId}` });
      }

      if (product.isQuoteOnly) {
        return res.status(400).json({ error: `Quote-only products cannot be purchased: ${product.name}` });
      }

      const priceData = computePrice(product, rateMap);
      // Never fall back to the stored `price` for a weighted product: that field
      // is the making charge, not the customer price. The rate check above
      // makes this unreachable; it stays as the last line of defence.
      if (!priceData && product.weight) {
        return res.status(503).json({ error: rateUnavailableMessage([product.metalType || "gold"]) });
      }
      // A weightless product sells at its stored price. Without one there is
      // nothing to charge — this used to reach the database as NaN and 500.
      const serverPrice = priceData?.finalPrice;
      if (!Number.isFinite(serverPrice)) {
        return res.status(400).json({ error: `${product.name} cannot be ordered right now — it has no price set.` });
      }
      const quantity = item.quantity || 1;
      totalAmount += serverPrice * quantity;

      const gstPercent = product.gstPercent || 0;
      const priceBeforeGst = serverPrice / (1 + gstPercent / 100);
      gstAmount += (serverPrice - priceBeforeGst) * quantity;

      verifiedItems.push({
        productId: product.productId || product._id.toString(),
        name: product.name,
        image: product.img || product.image || (product.images && product.images[0]),
        quantity,
        unitPrice: serverPrice,
        weight: product.weight,
        metalType: product.metalType,
        category: product.category,
      });
    }

    totalAmount = Math.round(totalAmount);
    gstAmount = Math.round(gstAmount);

    // Take stock before sending the customer to Razorpay, so two people cannot
    // both reach the payment screen holding the last piece. See utils/stock.js
    // for why reservation happens here rather than on payment confirmation.
    const reservation = await reserveStock(verifiedItems);
    if (!reservation.ok) {
      return res.status(409).json({ error: outOfStockMessage(reservation) });
    }

    let razorpayOrder;
    let order;
    try {
      // Create Razorpay order (amount in paise)
      razorpayOrder = await razorpay.orders.create({
        amount: totalAmount * 100, // Convert to paise
        currency: "INR",
        receipt: `ORD-${Date.now()}`,
        notes: {
          userId: req.user.userId,
          email: req.user.email,
        },
      });

      // Create order in our DB with pending status
      order = await Order.create({
        orderId: razorpayOrder.receipt,
        userId: req.user.userId,
        email: req.user.email,
        name: name || undefined,
        items: verifiedItems,
        totalAmount,
        gstAmount,
        shippingAddress,
        razorpayOrderId: razorpayOrder.id,
        paymentMethod: "razorpay",
        orderStatus: "pending",
        paymentStatus: "pending",
        stockReserved: true,
      });
    } catch (createError) {
      // Razorpay refused, or the order write failed. Either way no order is
      // holding this stock, so it must go back rather than vanish.
      await releaseStock(verifiedItems);
      throw createError;
    }

    res.json({
      success: true,
      razorpayOrderId: razorpayOrder.id,
      amount: totalAmount,
      currency: "INR",
      orderId: order._id,
      key: process.env.RAZORPAY_KEY_ID,
    });
  } catch (error) {
    console.error("Payment create-order error:", error);
    res.status(500).json({ error: "Failed to create payment order" });
  }
});

/**
 * Move an order from pending to paid, exactly once.
 *
 * Both the browser's /verify call and Razorpay's webhook can arrive for the
 * same payment, in either order, and both are legitimate. The transition is
 * made idempotent by conditioning the update on `paidAt: null` — the first
 * caller to win that update gets the document back and is the one that alerts
 * the owner; a later caller gets null and alerts nobody.
 *
 * Stock is deliberately NOT touched here. It was taken when the order was
 * created, so there is nothing to decrement at confirmation and therefore no
 * way for a double confirmation to double-decrement.
 *
 * @returns {{order: Object|null, alreadyConfirmed: boolean}}
 */
const confirmPayment = async ({ razorpayOrderId, razorpayPaymentId, source }) => {
  const order = await Order.findOneAndUpdate(
    { razorpayOrderId, paidAt: null },
    {
      razorpayPaymentId,
      paymentStatus: "paid",
      orderStatus: "processing",
      paymentMethod: "razorpay",
      paidAt: new Date(),
    },
    { new: true }
  );

  if (order) {
    // A payment can land after the sweeper already gave this order's stock
    // back — a delayed webhook against a checkout that looked abandoned. The
    // customer has paid, so the question is only whether we can still supply
    // the pieces. Take them again if they are there; escalate if they are not.
    if (order.expiredAt && !order.stockReserved) {
      return reclaimForLatePayment({ order, source });
    }

    console.log(`💰 Payment confirmed for ${order.orderId} via ${source}.`);
    // Only a confirmed payment is worth waking the owner for, and only once.
    sendOrderAlert({ order }).catch((err) =>
      console.error("Owner order alert failed (non-critical):", err.message)
    );
    return { order, alreadyConfirmed: false };
  }

  // Either already confirmed by the other path, or no such order.
  const existing = await Order.findOne({ razorpayOrderId });
  return { order: existing, alreadyConfirmed: Boolean(existing) };
};

/**
 * Payment captured for an order the sweeper had already expired.
 *
 * We re-attempt the reservation rather than refusing outright. The customer has
 * paid; in the common case the pieces are still on the shelf — nobody bought
 * them in the interim — and refusing would mean refunding an order we could
 * simply fulfil. Refusing every late payment would turn an ordinary delayed
 * webhook into a guaranteed refund and a lost sale.
 *
 * When the stock really is gone, we cannot ship, and no amount of retrying
 * changes that. Then the order is flagged for refund and the owner is told
 * immediately — this is the one case here that costs real money and needs a
 * person the same day.
 */
const reclaimForLatePayment = async ({ order, source }) => {
  const reservation = await reserveStock(order.items);

  if (reservation.ok) {
    const revived = await Order.findByIdAndUpdate(
      order._id,
      {
        stockReserved: true,
        orderStatus: "processing",
        expiredAt: null,
        cancellationReason: null,
      },
      { new: true }
    );
    console.log(
      `💰 Payment confirmed for ${order.orderId} via ${source} — arrived after expiry, ` +
        `stock was still available and has been re-reserved.`
    );
    sendOrderAlert({ order: revived }).catch((err) =>
      console.error("Owner order alert failed (non-critical):", err.message)
    );
    return { order: revived, alreadyConfirmed: false, reclaimed: true };
  }

  const flagged = await Order.findByIdAndUpdate(
    order._id,
    {
      refundRequired: true,
      orderStatus: "expired",
      cancellationReason:
        `Paid after the reservation expired, and ${reservation.product} was no longer ` +
        `available. This payment needs to be refunded.`,
    },
    { new: true }
  );

  console.error(
    `🚨 REFUND REQUIRED — ${order.orderId}: payment captured via ${source} after expiry, ` +
      `but ${reservation.product} is out of stock. Money taken with nothing to ship.`
  );

  // Unlike a routine expiry, this one wakes the owner. It is money held against
  // an order that cannot be fulfilled.
  sendRefundRequiredAlert({ order: flagged, product: reservation.product }).catch((err) =>
    console.error("Refund alert failed (non-critical):", err.message)
  );

  return { order: flagged, alreadyConfirmed: false, refundRequired: true };
};

// POST /api/payment/verify — verify Razorpay payment signature
router.post("/verify", verifyJWT, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: "Missing payment verification fields" });
    }

    if (!process.env.RAZORPAY_KEY_SECRET) {
      return res.status(503).json({ error: "Payment system not configured" });
    }

    // Verify signature
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: "Payment verification failed — invalid signature" });
    }

    const { order, alreadyConfirmed } = await confirmPayment({
      razorpayOrderId: razorpay_order_id,
      razorpayPaymentId: razorpay_payment_id,
      source: "browser verify",
    });

    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    // Scoped to the caller: the signature is the real gate, but an order should
    // only ever be readable by the customer it belongs to.
    if (order.userId !== req.user.userId) {
      return res.status(403).json({ error: "Not authorized to confirm this order" });
    }

    res.json({
      success: true,
      message: alreadyConfirmed
        ? "Payment already confirmed"
        : "Payment verified successfully",
      data: order,
    });
  } catch (error) {
    console.error("Payment verify error:", error);
    res.status(500).json({ error: "Payment verification failed" });
  }
});

// ─── POST /api/payment/webhook ───────────────────────────────────────────────
//
// Razorpay's server-to-server confirmation, and the reason an order no longer
// depends on the customer's browser surviving the redirect. Without it, a tab
// closed after payment left the money captured and the order pending forever,
// with no owner alert.
//
// Deliberately unauthenticated: the caller is Razorpay, not a signed-in user.
// The HMAC over the raw body is what authenticates it, which is why this route
// needs `req.rawBody` (captured by the express.json verify hook in index.js) —
// re-serialising the parsed body would change the bytes and break the digest.
router.post("/webhook", async (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    console.error("Razorpay webhook received but RAZORPAY_WEBHOOK_SECRET is not set.");
    return res.status(503).json({ error: "Webhook not configured" });
  }

  const signature = req.headers["x-razorpay-signature"];
  const rawBody = req.rawBody;

  if (!signature || !rawBody) {
    return res.status(400).json({ error: "Missing webhook signature or body" });
  }

  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

  // Constant-time compare — a plain !== leaks how much of the digest matched.
  const provided = Buffer.from(String(signature), "utf8");
  const computed = Buffer.from(expected, "utf8");
  if (provided.length !== computed.length || !crypto.timingSafeEqual(provided, computed)) {
    console.warn("Razorpay webhook rejected: signature mismatch.");
    return res.status(400).json({ error: "Invalid webhook signature" });
  }

  try {
    const event = req.body?.event;
    const payment = req.body?.payload?.payment?.entity;

    // Acknowledge anything we don't act on with a 200 — a non-2xx tells Razorpay
    // to retry, and retrying an event we will never handle achieves nothing.
    if (event !== "payment.captured" || !payment?.order_id) {
      return res.json({ success: true, ignored: true, event: event || null });
    }

    const { order, alreadyConfirmed } = await confirmPayment({
      razorpayOrderId: payment.order_id,
      razorpayPaymentId: payment.id,
      source: "webhook",
    });

    if (!order) {
      // A captured payment with no matching order is worth surfacing, but still
      // acknowledged: retries will not make the order appear.
      console.error(
        `Razorpay webhook: payment.captured for unknown order ${payment.order_id} (payment ${payment.id}).`
      );
      return res.json({ success: true, matched: false });
    }

    res.json({ success: true, matched: true, alreadyConfirmed });
  } catch (error) {
    // A 500 here asks Razorpay to retry, which is what we want for a transient
    // database failure.
    console.error("Razorpay webhook error:", error);
    res.status(500).json({ error: "Webhook processing failed" });
  }
});

export default router;
