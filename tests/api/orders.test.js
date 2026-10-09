import { describe, it, expect, vi } from "vitest";
import { useApp, mocks } from "../helpers/app.js";
import {
  seedCatalog,
  seedRates,
  createProduct,
  makeCustomer,
  makeAdmin,
  stockOf,
  insertOrder,
  daysAgo,
  PRODUCT_DEFS,
  SHIPPING,
} from "../helpers/factories.js";
import { Order } from "../../server/models/Order.js";
import { Cart } from "../../server/models/Cart.js";

const ctx = useApp();
const DAY = 24 * 60 * 60 * 1000;

const placeOrder = (token, items, extra = {}) =>
  ctx.api(token).post("/api/orders").send({
    items,
    paymentMethod: "cod",
    name: "Asha",
    shippingAddress: SHIPPING,
    ...extra,
  });

const createPayment = (token, items, extra = {}) =>
  ctx.api(token).post("/api/payment/create-order").send({ items, shippingAddress: SHIPPING, name: "Asha", ...extra });

// ─── Pricing integrity ───────────────────────────────────────────────────────

describe("pricing integrity — POST /api/orders", () => {
  it("ignores client-sent price, unitPrice and totalAmount; charges computePrice × qty", async () => {
    await seedCatalog();
    const { token } = await makeCustomer();
    const res = await placeOrder(
      token,
      [{ productId: "gold-ring", quantity: 2, price: 1, unitPrice: 1, totalAmount: 1 }],
      { totalAmount: 1, gstAmount: 0 }
    );
    expect(res.status).toBe(201);
    const o = res.body.data;
    expect(o.items[0].unitPrice).toBe(PRODUCT_DEFS.gold.expected);
    expect(o.totalAmount).toBe(PRODUCT_DEFS.gold.expected * 2);
  });

  it("gstAmount is the GST inside the total (78,400 + 3% → 2,352 per ring)", async () => {
    await seedCatalog();
    const { token } = await makeCustomer();
    const res = await placeOrder(token, [{ productId: "gold-ring", quantity: 2 }]);
    expect(res.body.data.gstAmount).toBe(2352 * 2);
  });

  it("multi-line basket sums each line; silver is priced from the silver rate", async () => {
    await seedCatalog();
    const { token } = await makeCustomer();
    const res = await placeOrder(token, [
      { productId: "gold-ring", quantity: 1 },
      { productId: "silver-anklet", quantity: 3 },
      { productId: "gift-box", quantity: 1 },
    ]);
    expect(res.status).toBe(201);
    expect(res.body.data.totalAmount).toBe(80752 + 3 * 5099 + 1500);
  });

  it("line items snapshot name, weight and metalType, keyed by productId even when ordered by _id", async () => {
    const cat = await seedCatalog();
    const { token } = await makeCustomer();
    const res = await placeOrder(token, [{ productId: String(cat.silver._id) }]);
    expect(res.body.data.items[0]).toMatchObject({
      productId: "silver-anklet",
      name: "Silver Anklet",
      weight: 50,
      metalType: "silver",
      unitPrice: 5099,
      quantity: 1,
    });
  });

  it("weight-0 product is charged its stored price", async () => {
    await seedCatalog();
    const { token } = await makeCustomer();
    expect((await placeOrder(token, [{ productId: "gift-box" }])).body.data.totalAmount).toBe(1500);
  });

  it("isFixedPrice:false products are priced from the rate, not the making charge", async () => {
    await seedRates();
    await createProduct("gold", { isFixedPrice: false });
    const { token } = await makeCustomer();
    expect((await placeOrder(token, [{ productId: "gold-ring" }])).body.data.totalAmount).toBe(80752);
  });

  it("quote-only product → 400, nothing reserved", async () => {
    await seedCatalog();
    const { token } = await makeCustomer();
    const res = await placeOrder(token, [{ productId: "diamond-set" }]);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Quote-only/);
    expect(await stockOf("diamond-set")).toBe(3);
  });

  it("unknown product → 400", async () => {
    await seedCatalog();
    const { token } = await makeCustomer();
    expect((await placeOrder(token, [{ productId: "nope" }])).status).toBe(400);
  });

  it.each([
    [{ items: [] }, /At least one item/],
    [{ items: [{ productId: "gold-ring", quantity: 0 }] }, /at least 1/],
    [{ items: [{ productId: "gold-ring", quantity: -1 }] }, /at least 1/],
    [{ items: [{ productId: "gold-ring", quantity: 1.5 }] }, /./],
    [{ items: [{ quantity: 1 }] }, /Product ID is required/],
    [{}, /./],
  ])("validation: %j → 400", async (body, msg) => {
    await seedCatalog();
    const { token } = await makeCustomer();
    const res = await ctx.api(token).post("/api/orders").send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(msg);
  });
});

describe("pricing integrity — POST /api/payment/create-order", () => {
  it("amount returned and sent to Razorpay is the server price, in paise", async () => {
    await seedCatalog();
    const { token } = await makeCustomer();
    const res = await createPayment(token, [{ productId: "gold-ring", quantity: 2, price: 1 }], { totalAmount: 1 });
    expect(res.status).toBe(200);
    expect(res.body.amount).toBe(80752 * 2);
    expect(mocks().razorpayCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 80752 * 2 * 100, currency: "INR" })
    );
    const o = await Order.findById(res.body.orderId).lean();
    expect(o).toMatchObject({ totalAmount: 161504, gstAmount: 4704, paymentMethod: "razorpay", paymentStatus: "pending" });
  });

  it("quote-only → 400", async () => {
    await seedCatalog();
    const { token } = await makeCustomer();
    expect((await createPayment(token, [{ productId: "diamond-set" }])).status).toBe(400);
  });

  it("empty items → 400", async () => {
    const { token } = await makeCustomer();
    expect((await createPayment(token, [])).status).toBe(400);
    expect((await ctx.api(token).post("/api/payment/create-order").send({})).status).toBe(400);
  });
});

describe("stale rates refuse checkout — only for the stale metal", () => {
  const staleGold = () => seedCatalog({ goldUpdatedAt: daysAgo(4) });
  const staleSilver = () => seedCatalog({ silverUpdatedAt: daysAgo(4) });

  it("stale gold: gold order → 503 on both routes", async () => {
    await staleGold();
    const { token } = await makeCustomer();
    const cod = await placeOrder(token, [{ productId: "gold-ring" }]);
    const card = await createPayment(token, [{ productId: "gold-ring" }]);
    expect(cod.status).toBe(503);
    expect(card.status).toBe(503);
    expect(cod.body.error).toMatch(/gold rate/);
    expect(await stockOf("gold-ring")).toBe(5);
    expect(await Order.countDocuments()).toBe(0);
  });

  it("stale gold: silver and weight-0 products still sell", async () => {
    await staleGold();
    const { token } = await makeCustomer();
    expect((await placeOrder(token, [{ productId: "silver-anklet" }])).status).toBe(201);
    expect((await placeOrder(token, [{ productId: "gift-box" }])).status).toBe(201);
    expect((await createPayment(token, [{ productId: "silver-anklet" }])).status).toBe(200);
  });

  it("stale silver: silver refused, gold fine", async () => {
    await staleSilver();
    const { token } = await makeCustomer();
    expect((await placeOrder(token, [{ productId: "silver-anklet" }])).status).toBe(503);
    expect((await createPayment(token, [{ productId: "silver-anklet" }])).status).toBe(503);
    expect((await placeOrder(token, [{ productId: "gold-ring" }])).status).toBe(201);
  });

  it("mixed basket with one stale metal is refused as a whole", async () => {
    await staleSilver();
    const { token } = await makeCustomer();
    const res = await placeOrder(token, [{ productId: "gold-ring" }, { productId: "silver-anklet" }]);
    expect(res.status).toBe(503);
    expect(await stockOf("gold-ring")).toBe(5);
  });

  it("a rate just under the limit is still accepted", async () => {
    await seedCatalog({ goldUpdatedAt: new Date(Date.now() - 3 * DAY + 60_000) });
    const { token } = await makeCustomer();
    expect((await placeOrder(token, [{ productId: "gold-ring" }])).status).toBe(201);
  });
});

// ─── Stock ───────────────────────────────────────────────────────────────────

describe("stock reservation through the order routes", () => {
  it("stock 0 → 409 (COD and card), nothing written", async () => {
    await seedRates();
    await createProduct("gold", { stock: 0 });
    const { token } = await makeCustomer();
    const cod = await placeOrder(token, [{ productId: "gold-ring" }]);
    const card = await createPayment(token, [{ productId: "gold-ring" }]);
    expect(cod.status).toBe(409);
    expect(cod.body.error).toMatch(/sold out/);
    expect(card.status).toBe(409);
    expect(await Order.countDocuments()).toBe(0);
    expect(mocks().razorpayCreate).not.toHaveBeenCalled();
  });

  it("quantity above stock → 409 naming what is left", async () => {
    await seedCatalog();
    const { token } = await makeCustomer();
    const res = await placeOrder(token, [{ productId: "gold-ring", quantity: 6 }]);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/only 5 left/);
  });

  it("10 parallel COD orders for a stock-1 piece: exactly one wins, stock ends at 0", async () => {
    await seedCatalog();
    const customers = await Promise.all(Array.from({ length: 10 }, () => makeCustomer()));
    const results = await Promise.all(customers.map((c) => placeOrder(c.token, [{ productId: "one-of-a-kind" }])));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(9);
    expect(await stockOf("one-of-a-kind")).toBe(0);
    expect(await Order.countDocuments()).toBe(1);
  });

  it("10 parallel card checkouts for a stock-1 piece: exactly one reaches Razorpay", async () => {
    await seedCatalog();
    const customers = await Promise.all(Array.from({ length: 10 }, () => makeCustomer()));
    const results = await Promise.all(customers.map((c) => createPayment(c.token, [{ productId: "one-of-a-kind" }])));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(mocks().razorpayCreate).toHaveBeenCalledTimes(1);
    expect(await stockOf("one-of-a-kind")).toBe(0);
  });

  it("multi-item order where the 2nd line fails leaves the 1st line's stock untouched", async () => {
    await seedCatalog();
    const { token } = await makeCustomer();
    const res = await placeOrder(token, [
      { productId: "gold-ring", quantity: 2 },
      { productId: "one-of-a-kind", quantity: 2 },
    ]);
    expect(res.status).toBe(409);
    expect(await stockOf("gold-ring")).toBe(5);
    expect(await stockOf("one-of-a-kind")).toBe(1);
  });

  it("a successful order decrements stock and marks the order as holding it", async () => {
    await seedCatalog();
    const { token } = await makeCustomer();
    const res = await placeOrder(token, [{ productId: "gold-ring", quantity: 2 }]);
    expect(await stockOf("gold-ring")).toBe(3);
    expect((await Order.findById(res.body.data._id).lean()).stockReserved).toBe(true);
  });
});

describe("restock on cancel / reject happens exactly once", () => {
  const setup = async () => {
    await seedCatalog();
    const customer = await makeCustomer();
    const admin = await makeAdmin();
    const res = await placeOrder(customer.token, [{ productId: "gold-ring", quantity: 2 }]);
    return { customer, admin, order: res.body.data };
  };

  it("customer cancel restocks", async () => {
    const { customer, order } = await setup();
    expect((await ctx.api(customer.token).patch(`/api/orders/${order._id}/cancel`)).status).toBe(200);
    expect(await stockOf("gold-ring")).toBe(5);
  });

  it("owner reject restocks", async () => {
    const { admin, order } = await setup();
    const res = await ctx.api(admin.token).patch(`/api/orders/${order._id}/approval`).send({ approvalStatus: "REJECTED", rejectionReason: "Out of hallmark stock" });
    expect(res.status).toBe(200);
    expect(await stockOf("gold-ring")).toBe(5);
  });

  it("reject then customer cancel does not double-restock", async () => {
    const { customer, admin, order } = await setup();
    await ctx.api(admin.token).patch(`/api/orders/${order._id}/approval`).send({ approvalStatus: "REJECTED", rejectionReason: "x" });
    await ctx.api(customer.token).patch(`/api/orders/${order._id}/cancel`);
    expect(await stockOf("gold-ring")).toBe(5);
  });

  it("cancel then reject does not double-restock", async () => {
    const { customer, admin, order } = await setup();
    await ctx.api(customer.token).patch(`/api/orders/${order._id}/cancel`);
    await ctx.api(admin.token).patch(`/api/orders/${order._id}/approval`).send({ approvalStatus: "REJECTED", rejectionReason: "x" });
    expect(await stockOf("gold-ring")).toBe(5);
  });

  it("cancelling twice restocks once (second attempt 400)", async () => {
    const { customer, order } = await setup();
    await ctx.api(customer.token).patch(`/api/orders/${order._id}/cancel`);
    const again = await ctx.api(customer.token).patch(`/api/orders/${order._id}/cancel`);
    expect(again.status).toBe(400);
    expect(await stockOf("gold-ring")).toBe(5);
  });

  it("legacy order with stockReserved:false restocks nothing", async () => {
    await seedCatalog();
    const customer = await makeCustomer();
    const o = await insertOrder({ userId: String(customer.user._id), stockReserved: false });
    await ctx.api(customer.token).patch(`/api/orders/${o._id}/cancel`);
    expect(await stockOf("gold-ring")).toBe(5);
  });
});

// ─── Lifecycle ───────────────────────────────────────────────────────────────

describe("approval rules", () => {
  const setup = async () => {
    const admin = await makeAdmin();
    const o = await insertOrder();
    const approve = (body = {}) =>
      ctx.api(admin.token).patch(`/api/orders/${o._id}/approval`).send({ approvalStatus: "APPROVED", ...body });
    const reject = (reason = "Not available") =>
      ctx.api(admin.token).patch(`/api/orders/${o._id}/approval`).send({ approvalStatus: "REJECTED", rejectionReason: reason });
    const status = (s) => ctx.api(admin.token).patch(`/api/orders/${o._id}/status`).send({ status: s });
    return { admin, o, approve, reject, status };
  };

  it("approve sets approvedAt and expectedDeliveryDate = approvedAt + exactly 15 days", async () => {
    const { approve, o } = await setup();
    const before = Date.now();
    const res = await approve();
    expect(res.status).toBe(200);
    const saved = await Order.findById(o._id).lean();
    expect(saved.approvalStatus).toBe("APPROVED");
    expect(saved.approvedAt.getTime()).toBeGreaterThanOrEqual(before - 1);
    expect(saved.expectedDeliveryDate.getTime() - saved.approvedAt.getTime()).toBe(15 * DAY);
    expect(mocks().whatsapp.sendOrderApprovalAlert).toHaveBeenCalledTimes(1);
  });

  it("a client-supplied expectedDeliveryDate / approvedAt is ignored", async () => {
    const { approve, o } = await setup();
    await approve({ expectedDeliveryDate: "2020-01-01", approvedAt: "2020-01-01" });
    const saved = await Order.findById(o._id).lean();
    expect(saved.expectedDeliveryDate.getFullYear()).toBeGreaterThan(2025);
  });

  it("re-approving is refused and does not move the date", async () => {
    const { approve, o } = await setup();
    await approve();
    const first = (await Order.findById(o._id).lean()).expectedDeliveryDate;
    const again = await approve();
    expect(again.status).toBe(400);
    expect((await Order.findById(o._id).lean()).expectedDeliveryDate).toEqual(first);
  });

  it("approved → rejected is refused", async () => {
    const { approve, reject } = await setup();
    await approve();
    const res = await reject();
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot be rejected/);
  });

  it("reject needs a reason", async () => {
    const { admin, o } = await setup();
    const res = await ctx.api(admin.token).patch(`/api/orders/${o._id}/approval`).send({ approvalStatus: "REJECTED" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reason is required/);
  });

  it("reject stores the reason and clears any delivery promise", async () => {
    const { reject, o } = await setup();
    expect((await reject("Hallmark issue")).status).toBe(200);
    const saved = await Order.findById(o._id).lean();
    expect(saved).toMatchObject({ approvalStatus: "REJECTED", rejectionReason: "Hallmark issue", expectedDeliveryDate: null, approvedAt: null });
  });

  it("re-rejecting is refused", async () => {
    const { reject } = await setup();
    await reject();
    expect((await reject()).status).toBe(400);
  });

  it("invalid approvalStatus → 400; unknown order → 404", async () => {
    const { admin } = await setup();
    expect((await ctx.api(admin.token).patch(`/api/orders/0123456789abcdef01234567/approval`).send({ approvalStatus: "APPROVED" })).status).toBe(404);
    const o2 = await insertOrder();
    expect((await ctx.api(admin.token).patch(`/api/orders/${o2._id}/approval`).send({ approvalStatus: "MAYBE" })).status).toBe(400);
  });

  it("shipped / delivered before approval → 400", async () => {
    const { status } = await setup();
    expect((await status("shipped")).status).toBe(400);
    expect((await status("delivered")).status).toBe(400);
  });

  it("after approval: shipped then delivered; deliveredAt stamped once", async () => {
    const { approve, status, o } = await setup();
    await approve();
    expect((await status("shipped")).status).toBe(200);
    expect((await status("delivered")).status).toBe(200);
    const first = (await Order.findById(o._id).lean()).deliveredAt;
    expect(first).toBeInstanceOf(Date);
    await new Promise((r) => setTimeout(r, 10));
    await status("delivered");
    expect((await Order.findById(o._id).lean()).deliveredAt).toEqual(first);
  });

  it("invalid status value → 400", async () => {
    const { status } = await setup();
    expect((await status("teleported")).status).toBe(400);
  });
});

describe("customer cancel", () => {
  it("own processing order within 7 days → cancelled", async () => {
    const c = await makeCustomer();
    const o = await insertOrder({ userId: String(c.user._id), createdAt: daysAgo(6.9) });
    const res = await ctx.api(c.token).patch(`/api/orders/${o._id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.data.orderStatus).toBe("cancelled");
  });

  it("after 7 days → 400", async () => {
    const c = await makeCustomer();
    const o = await insertOrder({ userId: String(c.user._id), createdAt: daysAgo(7.01) });
    const res = await ctx.api(c.token).patch(`/api/orders/${o._id}/cancel`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/7 days/);
  });

  it.each(["shipped", "delivered", "cancelled", "expired", "pending"])("when %s → 400", async (orderStatus) => {
    const c = await makeCustomer();
    const o = await insertOrder({ userId: String(c.user._id), orderStatus });
    expect((await ctx.api(c.token).patch(`/api/orders/${o._id}/cancel`)).status).toBe(400);
  });

  it("someone else's order → 403", async () => {
    const owner = await makeCustomer();
    const other = await makeCustomer();
    const o = await insertOrder({ userId: String(owner.user._id) });
    expect((await ctx.api(other.token).patch(`/api/orders/${o._id}/cancel`)).status).toBe(403);
  });

  it("unknown order → 404", async () => {
    const c = await makeCustomer();
    expect((await ctx.api(c.token).patch(`/api/orders/0123456789abcdef01234567/cancel`)).status).toBe(404);
  });
});

describe("cart clearing and Buy Now", () => {
  const addToCart = (token, productId) =>
    ctx.api(token).post("/api/cart").send({ productId, name: productId, quantity: 1 });

  it("a normal order clears the customer's cart (and only theirs)", async () => {
    await seedCatalog();
    const c = await makeCustomer();
    const other = await makeCustomer();
    await addToCart(c.token, "gold-ring");
    await addToCart(other.token, "gold-ring");
    await placeOrder(c.token, [{ productId: "gold-ring" }]);
    expect(await Cart.countDocuments({ userId: String(c.user._id) })).toBe(0);
    expect(await Cart.countDocuments({ userId: String(other.user._id) })).toBe(1);
  });

  it("buyNow:true keeps the cart intact", async () => {
    await seedCatalog();
    const c = await makeCustomer();
    await addToCart(c.token, "silver-anklet");
    const res = await placeOrder(c.token, [{ productId: "gold-ring" }], { buyNow: true });
    expect(res.status).toBe(201);
    expect(await Cart.countDocuments({ userId: String(c.user._id) })).toBe(1);
  });

  it("a failed order (409) leaves the cart intact", async () => {
    await seedRates();
    await createProduct("gold", { stock: 0 });
    const c = await makeCustomer();
    await addToCart(c.token, "gold-ring");
    await placeOrder(c.token, [{ productId: "gold-ring" }]);
    expect(await Cart.countDocuments({ userId: String(c.user._id) })).toBe(1);
  });

  it("DELETE /api/orders/delete-cart-items clears only the caller's cart", async () => {
    // Only catalogue products can be added (B14).
    await createProduct("a", { productId: "a", name: "A", category: "Gold" });
    const c = await makeCustomer();
    const other = await makeCustomer();
    await addToCart(c.token, "a");
    await addToCart(other.token, "a");
    const res = await ctx.api(c.token).delete("/api/orders/delete-cart-items");
    expect(res.body).toEqual({ deletedCount: 1, success: true });
    expect(await Cart.countDocuments({ userId: String(other.user._id) })).toBe(1);
  });
});

describe("owner alerts on order creation", () => {
  it("the customer's profile phone is copied onto every order (COD and card)", async () => {
    await seedCatalog();
    const c = await makeCustomer();
    const cod = await placeOrder(c.token, [{ productId: "gold-ring" }]);
    const card = await createPayment(c.token, [{ productId: "silver-anklet" }]);
    expect((await Order.findById(cod.body.data._id).lean()).phone).toBe(c.user.phone);
    expect((await Order.findById(card.body.orderId).lean()).phone).toBe(c.user.phone);
  });

  it("with no mobile on the shipping address, the owner's alert still gets a number (the profile phone)", async () => {
    await seedCatalog();
    const c = await makeCustomer();
    await placeOrder(c.token, [{ productId: "gold-ring" }], { shippingAddress: { ...SHIPPING, mobileNumber: undefined, number: undefined } });
    const { order } = mocks().whatsapp.sendOrderAlert.mock.calls[0][0];
    const wa = await vi.importActual("../../server/utils/whatsapp.js");
    process.env.WHATSAPP_TOKEN = "t";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "1";
    process.env.ADMIN_WHATSAPP_NUMBER = "91";
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => "" }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await wa.sendOrderAlert({ order: order.toObject ? order.toObject() : order });
      const text = JSON.parse(fetchMock.mock.calls[0][1].body).text.body;
      expect(text).toContain(c.user.phone);
      expect(text).not.toMatch(/\n—\n/);
    } finally {
      delete process.env.WHATSAPP_TOKEN;
      delete process.env.WHATSAPP_PHONE_NUMBER_ID;
      delete process.env.ADMIN_WHATSAPP_NUMBER;
    }
  });

  it("COD order alerts the owner once", async () => {
    await seedCatalog();
    const c = await makeCustomer();
    await placeOrder(c.token, [{ productId: "gold-ring" }]);
    expect(mocks().whatsapp.sendOrderAlert).toHaveBeenCalledTimes(1);
    expect(mocks().whatsapp.sendOrderAlert.mock.calls[0][0].order.paymentMethod).toBe("cod");
  });

  it("an alert failure does not fail the order", async () => {
    await seedCatalog();
    mocks().whatsapp.sendOrderAlert.mockRejectedValueOnce(new Error("WhatsApp down"));
    const c = await makeCustomer();
    expect((await placeOrder(c.token, [{ productId: "gold-ring" }])).status).toBe(201);
  });

  it("card create-order does NOT alert (only a confirmed payment does)", async () => {
    await seedCatalog();
    const c = await makeCustomer();
    await createPayment(c.token, [{ productId: "gold-ring" }]);
    expect(mocks().whatsapp.sendOrderAlert).not.toHaveBeenCalled();
  });
});

describe("reading orders", () => {
  it("GET /api/orders returns only the caller's orders, newest first", async () => {
    const a = await makeCustomer();
    const b = await makeCustomer();
    await insertOrder({ userId: String(a.user._id), createdAt: daysAgo(2) });
    const newest = await insertOrder({ userId: String(a.user._id), createdAt: daysAgo(1) });
    await insertOrder({ userId: String(b.user._id) });
    const res = await ctx.api(a.token).get("/api/orders");
    expect(res.body).toHaveLength(2);
    expect(res.body[0]._id).toBe(String(newest._id));
  });

  it("GET /api/orders/:id — owner 200, other customer 403, admin 200, unknown 404", async () => {
    const owner = await makeCustomer();
    const other = await makeCustomer();
    const admin = await makeAdmin();
    const o = await insertOrder({ userId: String(owner.user._id) });
    expect((await ctx.api(owner.token).get(`/api/orders/${o._id}`)).status).toBe(200);
    expect((await ctx.api(other.token).get(`/api/orders/${o._id}`)).status).toBe(403);
    expect((await ctx.api(admin.token).get(`/api/orders/${o._id}`)).status).toBe(200);
    expect((await ctx.api(owner.token).get(`/api/orders/0123456789abcdef01234567`)).status).toBe(404);
  });

  it("GET /api/orders/admin/all returns every order", async () => {
    const admin = await makeAdmin();
    await insertOrder();
    await insertOrder();
    const res = await ctx.api(admin.token).get("/api/orders/admin/all");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it("empty collections return [] not 500", async () => {
    const admin = await makeAdmin();
    const c = await makeCustomer();
    expect((await ctx.api(c.token).get("/api/orders")).body).toEqual([]);
    expect((await ctx.api(admin.token).get("/api/orders/admin/all")).body).toEqual([]);
  });
});

describe("lifecycle table through the routes (S7)", () => {
  it("admin cancelling an unpaid online order releases its stock", async () => {
    await seedCatalog();
    const c = await makeCustomer();
    const admin = await makeAdmin();
    const created = await createPayment(c.token, [{ productId: "gold-ring" }]);
    expect(await stockOf("gold-ring")).toBe(4);
    const res = await ctx.api(admin.token).patch(`/api/orders/${created.body.orderId}/status`).send({ status: "cancelled" });
    expect(res.status).toBe(200);
    expect(await stockOf("gold-ring")).toBe(5);
  });

  it("a shipped order cannot be cancelled or moved back", async () => {
    const admin = await makeAdmin();
    const o = await insertOrder({ orderStatus: "shipped", approvalStatus: "APPROVED" });
    for (const status of ["cancelled", "processing"]) {
      expect((await ctx.api(admin.token).patch(`/api/orders/${o._id}/status`).send({ status })).status, status).toBe(400);
    }
  });

  it("an admin cancel followed by a customer cancel restocks once", async () => {
    await seedCatalog();
    const c = await makeCustomer();
    const admin = await makeAdmin();
    const placed = await placeOrder(c.token, [{ productId: "gold-ring", quantity: 2 }]);
    await ctx.api(admin.token).patch(`/api/orders/${placed.body.data._id}/status`).send({ status: "cancelled" });
    await ctx.api(c.token).patch(`/api/orders/${placed.body.data._id}/cancel`);
    expect(await stockOf("gold-ring")).toBe(5);
  });
});
