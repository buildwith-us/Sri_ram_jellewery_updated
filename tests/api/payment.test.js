import { describe, it, expect } from "vitest";
import { useApp, mocks } from "../helpers/app.js";
import {
  seedCatalog,
  makeCustomer,
  stockOf,
  razorpaySignature,
  webhookPayload,
  webhookSignature,
  SHIPPING,
} from "../helpers/factories.js";
import { Order } from "../../server/models/Order.js";
import { Product } from "../../server/models/Product.js";
import { Cart } from "../../server/models/Cart.js";
import { releaseStaleReservations } from "../../server/utils/stock.js";

const ctx = useApp();

const createPayment = (token, items) =>
  ctx.api(token).post("/api/payment/create-order").send({ items, shippingAddress: SHIPPING, name: "Asha" });

const verify = (token, razorpay_order_id, razorpay_payment_id = "pay_TEST123", sig) =>
  ctx.api(token).post("/api/payment/verify").send({
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature: sig ?? razorpaySignature(razorpay_order_id, razorpay_payment_id),
  });

const webhook = (raw, sig = webhookSignature(raw)) => {
  const t = ctx.api().post("/api/payment/webhook").set("Content-Type", "application/json");
  if (sig !== null) t.set("X-Razorpay-Signature", sig);
  return t.send(raw);
};

/** A customer with a pending card order for one gold ring. */
const pendingCardOrder = async () => {
  await seedCatalog();
  const customer = await makeCustomer();
  const res = await createPayment(customer.token, [{ productId: "gold-ring" }]);
  expect(res.status).toBe(200);
  return { customer, rzpId: res.body.razorpayOrderId, orderId: res.body.orderId };
};

// Must run first: getRazorpay() caches the SDK instance once it has keys.
describe("create-order without Razorpay keys", () => {
  it("→ 503 and reserves nothing", async () => {
    await seedCatalog();
    const saved = process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_ID;
    try {
      const c = await makeCustomer();
      const res = await createPayment(c.token, [{ productId: "gold-ring" }]);
      expect(res.status).toBe(503);
      expect(await stockOf("gold-ring")).toBe(5);
    } finally {
      process.env.RAZORPAY_KEY_ID = saved;
    }
  });
});

describe("POST /api/payment/create-order", () => {
  it("reserves stock and records a pending razorpay order", async () => {
    const { rzpId, orderId, customer } = await pendingCardOrder();
    expect(await stockOf("gold-ring")).toBe(4);
    const o = await Order.findById(orderId).lean();
    expect(o).toMatchObject({
      razorpayOrderId: rzpId,
      userId: String(customer.user._id),
      paymentMethod: "razorpay",
      paymentStatus: "pending",
      orderStatus: "pending",
      stockReserved: true,
      paidAt: null,
    });
    expect(o.shippingAddress).toMatchObject({ postalCode: "625001" });
  });

  it("returns the public key id, never the secret", async () => {
    await seedCatalog();
    const c = await makeCustomer();
    const res = await createPayment(c.token, [{ productId: "gold-ring" }]);
    expect(res.body.key).toBe(process.env.RAZORPAY_KEY_ID);
    expect(JSON.stringify(res.body)).not.toContain(process.env.RAZORPAY_KEY_SECRET);
  });

  it("Razorpay failure → 500, stock released, no order left behind", async () => {
    await seedCatalog();
    mocks().razorpayCreate.mockRejectedValueOnce(new Error("Razorpay 502"));
    const c = await makeCustomer();
    const res = await createPayment(c.token, [{ productId: "gold-ring", quantity: 2 }]);
    expect(res.status).toBe(500);
    expect(await stockOf("gold-ring")).toBe(5);
    expect(await Order.countDocuments()).toBe(0);
  });

  it("DB write failure after Razorpay → stock released", async () => {
    await seedCatalog();
    // Duplicate receipt → unique orderId violation on Order.create.
    await Order.create({ orderId: "ORD-DUP", totalAmount: 1, items: [] });
    mocks().razorpayCreate.mockResolvedValueOnce({ id: "order_DUP", receipt: "ORD-DUP", amount: 1 });
    const c = await makeCustomer();
    const res = await createPayment(c.token, [{ productId: "gold-ring" }]);
    expect(res.status).toBe(500);
    expect(await stockOf("gold-ring")).toBe(5);
  });
});

describe("POST /api/payment/verify", () => {
  it("valid signature → paid once, owner alerted once", async () => {
    const { customer, rzpId, orderId } = await pendingCardOrder();
    const res = await verify(customer.token, rzpId, "pay_A1");
    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Payment verified successfully");
    const o = await Order.findById(orderId).lean();
    expect(o).toMatchObject({ paymentStatus: "paid", orderStatus: "processing", razorpayPaymentId: "pay_A1" });
    expect(o.paidAt).toBeInstanceOf(Date);
    expect(mocks().whatsapp.sendOrderAlert).toHaveBeenCalledTimes(1);
    // Stock is not touched again at confirmation.
    expect(await stockOf("gold-ring")).toBe(4);
  });

  it("bad signature → 400 and nothing changes", async () => {
    const { customer, rzpId, orderId } = await pendingCardOrder();
    const res = await verify(customer.token, rzpId, "pay_A1", "0".repeat(64));
    expect(res.status).toBe(400);
    expect((await Order.findById(orderId).lean()).paidAt).toBeNull();
  });

  it("signature for a different payment id → 400", async () => {
    const { customer, rzpId } = await pendingCardOrder();
    const res = await verify(customer.token, rzpId, "pay_A1", razorpaySignature(rzpId, "pay_OTHER"));
    expect(res.status).toBe(400);
  });

  it("missing fields → 400", async () => {
    const c = await makeCustomer();
    expect((await ctx.api(c.token).post("/api/payment/verify").send({ razorpay_order_id: "x" })).status).toBe(400);
  });

  it("verify twice → still one confirmation, one alert, same paidAt", async () => {
    const { customer, rzpId, orderId } = await pendingCardOrder();
    await verify(customer.token, rzpId, "pay_A1");
    const paidAt = (await Order.findById(orderId).lean()).paidAt;
    const again = await verify(customer.token, rzpId, "pay_A1");
    expect(again.status).toBe(200);
    expect(again.body.message).toBe("Payment already confirmed");
    expect((await Order.findById(orderId).lean()).paidAt).toEqual(paidAt);
    expect(mocks().whatsapp.sendOrderAlert).toHaveBeenCalledTimes(1);
  });

  it("verify then webhook → one alert", async () => {
    const { customer, rzpId } = await pendingCardOrder();
    await verify(customer.token, rzpId, "pay_A1");
    const res = await webhook(webhookPayload(rzpId, "pay_A1"));
    expect(res.body).toMatchObject({ matched: true, alreadyConfirmed: true });
    expect(mocks().whatsapp.sendOrderAlert).toHaveBeenCalledTimes(1);
  });

  it("webhook then verify → one alert", async () => {
    const { customer, rzpId } = await pendingCardOrder();
    await webhook(webhookPayload(rzpId, "pay_A1"));
    const res = await verify(customer.token, rzpId, "pay_A1");
    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Payment already confirmed");
    expect(mocks().whatsapp.sendOrderAlert).toHaveBeenCalledTimes(1);
  });

  it("verify and webhook racing → exactly one alert", async () => {
    const { customer, rzpId } = await pendingCardOrder();
    await Promise.all([
      verify(customer.token, rzpId, "pay_A1"),
      webhook(webhookPayload(rzpId, "pay_A1")),
      verify(customer.token, rzpId, "pay_A1"),
    ]);
    expect(mocks().whatsapp.sendOrderAlert).toHaveBeenCalledTimes(1);
  });

  it("another customer verifying → 403", async () => {
    const { rzpId } = await pendingCardOrder();
    const intruder = await makeCustomer();
    const res = await verify(intruder.token, rzpId, "pay_A1");
    expect(res.status).toBe(403);
    expect(res.body.data).toBeUndefined();
  });

  it("valid signature for an unknown order → 404", async () => {
    const c = await makeCustomer();
    expect((await verify(c.token, "order_UNKNOWN", "pay_X")).status).toBe(404);
  });

  it("without RAZORPAY_KEY_SECRET → 503", async () => {
    const c = await makeCustomer();
    const saved = process.env.RAZORPAY_KEY_SECRET;
    const sig = razorpaySignature("o", "p");
    delete process.env.RAZORPAY_KEY_SECRET;
    try {
      const res = await ctx.api(c.token).post("/api/payment/verify").send({ razorpay_order_id: "o", razorpay_payment_id: "p", razorpay_signature: sig });
      expect(res.status).toBe(503);
    } finally {
      process.env.RAZORPAY_KEY_SECRET = saved;
    }
  });
});

describe("POST /api/payment/webhook", () => {
  it("valid payment.captured → paid and alerted", async () => {
    const { rzpId, orderId } = await pendingCardOrder();
    const res = await webhook(webhookPayload(rzpId, "pay_W1"));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, matched: true, alreadyConfirmed: false });
    expect((await Order.findById(orderId).lean()).paymentStatus).toBe("paid");
    expect(mocks().whatsapp.sendOrderAlert).toHaveBeenCalledTimes(1);
  });

  it("bad signature → 400", async () => {
    const { rzpId, orderId } = await pendingCardOrder();
    const raw = webhookPayload(rzpId);
    expect((await webhook(raw, webhookSignature(raw, "wrong-secret"))).status).toBe(400);
    expect((await Order.findById(orderId).lean()).paidAt).toBeNull();
  });

  it("signature of a different length → 400 (no timingSafeEqual throw)", async () => {
    const { rzpId } = await pendingCardOrder();
    expect((await webhook(webhookPayload(rzpId), "abc")).status).toBe(400);
  });

  it("missing signature → 400", async () => {
    const { rzpId } = await pendingCardOrder();
    expect((await webhook(webhookPayload(rzpId), null)).status).toBe(400);
  });

  it("signature over re-serialised JSON (different bytes) is rejected", async () => {
    const { rzpId } = await pendingCardOrder();
    const raw = webhookPayload(rzpId);
    const pretty = JSON.stringify(JSON.parse(raw), null, 2);
    expect((await webhook(pretty, webhookSignature(raw))).status).toBe(400);
    // …and accepted when signed over the exact bytes sent.
    expect((await webhook(pretty, webhookSignature(pretty))).status).toBe(200);
  });

  it("non payment.captured event → 200 ignored", async () => {
    const { rzpId, orderId } = await pendingCardOrder();
    const res = await webhook(webhookPayload(rzpId, "pay_1", "payment.failed"));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ignored: true, event: "payment.failed" });
    expect((await Order.findById(orderId).lean()).paidAt).toBeNull();
  });

  it("unknown order → 200 matched:false", async () => {
    const res = await webhook(webhookPayload("order_NOPE"));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, matched: false });
  });

  it("RAZORPAY_WEBHOOK_SECRET unset → 503", async () => {
    const saved = process.env.RAZORPAY_WEBHOOK_SECRET;
    const raw = webhookPayload("order_x");
    const sig = webhookSignature(raw);
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    try {
      expect((await webhook(raw, sig)).status).toBe(503);
    } finally {
      process.env.RAZORPAY_WEBHOOK_SECRET = saved;
    }
  });
});

describe("late payment after the sweeper expired the order", () => {
  const expireIt = async (orderId) => {
    await Order.updateOne({ _id: orderId }, { createdAt: new Date(Date.now() - 60 * 60 * 1000) });
    const r = await releaseStaleReservations();
    expect(r.released).toHaveLength(1);
  };

  it("stock still available → re-reserved, order live again, owner alerted", async () => {
    const { rzpId, orderId } = await pendingCardOrder();
    await expireIt(orderId);
    expect(await stockOf("gold-ring")).toBe(5);
    const res = await webhook(webhookPayload(rzpId, "pay_LATE"));
    expect(res.status).toBe(200);
    const o = await Order.findById(orderId).lean();
    expect(o).toMatchObject({
      paymentStatus: "paid",
      orderStatus: "processing",
      stockReserved: true,
      expiredAt: null,
      refundRequired: false,
    });
    expect(await stockOf("gold-ring")).toBe(4);
    expect(mocks().whatsapp.sendOrderAlert).toHaveBeenCalledTimes(1);
    expect(mocks().whatsapp.sendRefundRequiredAlert).not.toHaveBeenCalled();
  });

  it("stock gone → refundRequired, stays expired, refund alert (no order alert)", async () => {
    const { customer, rzpId, orderId } = await pendingCardOrder();
    await expireIt(orderId);
    await Product.updateOne({ productId: "gold-ring" }, { stock: 0 });
    const res = await verify(customer.token, rzpId, "pay_LATE");
    expect(res.status).toBe(200);
    const o = await Order.findById(orderId).lean();
    expect(o).toMatchObject({ refundRequired: true, orderStatus: "expired", paymentStatus: "paid" });
    expect(o.cancellationReason).toMatch(/needs to be refunded/);
    expect(await stockOf("gold-ring")).toBe(0);
    expect(mocks().whatsapp.sendRefundRequiredAlert).toHaveBeenCalledTimes(1);
    expect(mocks().whatsapp.sendOrderAlert).not.toHaveBeenCalled();
  });

  it("a payment that beats the sweeper is never expired", async () => {
    const { customer, rzpId, orderId } = await pendingCardOrder();
    await verify(customer.token, rzpId, "pay_OK");
    await Order.updateOne({ _id: orderId }, { createdAt: new Date(Date.now() - 60 * 60 * 1000) });
    expect((await releaseStaleReservations()).released).toHaveLength(0);
    expect(await stockOf("gold-ring")).toBe(4);
  });
});

// Decision 1: the UPI / QR SCAN tile pays through the SAME Razorpay path as
// the card tile (Razorpay's own checkout offers UPI and QR). There is no
// UPI-specific server code, so these are that path's guarantees as the UPI
// tile relies on them.
describe("UPI tile → the existing Razorpay flow", () => {
  const bagAndCreate = async () => {
    await seedCatalog();
    const customer = await makeCustomer();
    await ctx.api(customer.token).post("/api/cart").send({ productId: "gold-ring", name: "Gold Ring", quantity: 1 });
    const created = await createPayment(customer.token, [{ productId: "gold-ring" }]);
    expect(created.status).toBe(200);
    return { customer, rzpId: created.body.razorpayOrderId, orderId: created.body.orderId };
  };

  it("a UPI payment that completes is saved paid, alerted once", async () => {
    const { customer, rzpId, orderId } = await bagAndCreate();
    const res = await verify(customer.token, rzpId, "pay_UPI1");
    expect(res.status).toBe(200);
    const o = await Order.findById(orderId).lean();
    expect(o).toMatchObject({ paymentStatus: "paid", paymentMethod: "razorpay", orderStatus: "processing" });
    expect(o.paidAt).toBeInstanceOf(Date);
    expect(mocks().whatsapp.sendOrderAlert).toHaveBeenCalledTimes(1);
  });

  it("an abandoned UPI payment: no paid order, the bag is kept, the pending order expires and restocks", async () => {
    const { customer, orderId } = await bagAndCreate();
    expect(await stockOf("gold-ring")).toBe(4); // reserved while Razorpay is open
    // The customer closes Razorpay: no /verify, no webhook.
    expect(await Order.countDocuments({ paidAt: { $ne: null } })).toBe(0);
    expect(await Cart.countDocuments({ userId: String(customer.user._id) })).toBe(1);
    expect(mocks().whatsapp.sendOrderAlert).not.toHaveBeenCalled();
    // 30 minutes later the sweeper gives the piece back.
    await Order.updateOne({ _id: orderId }, { createdAt: new Date(Date.now() - 60 * 60 * 1000) });
    expect((await releaseStaleReservations()).released).toHaveLength(1);
    expect((await Order.findById(orderId).lean()).orderStatus).toBe("expired");
    expect(await stockOf("gold-ring")).toBe(5);
    expect(await Cart.countDocuments({ userId: String(customer.user._id) })).toBe(1);
  });
});
