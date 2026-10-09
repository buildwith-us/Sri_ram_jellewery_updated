/**
 * Bugs found while reading the code, beyond the nine in suspected.test.js.
 * Same convention: `bug(` = confirmed, asserts the correct behaviour, passes
 * today only because it fails. `it(… (impact))` pins what happens today.
 * IDs (B1 …) match the bug table in the report.
 */
import { describe, it, expect, afterEach } from "vitest";
import { useApp, mocks } from "../helpers/app.js";
import { bug } from "../helpers/bug.js";
import {
  seedCatalog,
  seedRates,
  createProduct,
  makeCustomer,
  makeAdmin,
  insertOrder,
  stockOf,
  uniquePhone,
  uniqueEmail,
  razorpaySignature,
  SHIPPING,
} from "../helpers/factories.js";
import { Order } from "../../server/models/Order.js";
import { Cart } from "../../server/models/Cart.js";
import { User } from "../../server/models/User.js";
import { Category } from "../../server/models/Category.js";

const ctx = useApp();

const envBackup = {};
const setEnv = (k, v) => {
  if (!(k in envBackup)) envBackup[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
};
afterEach(() => {
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete envBackup[k];
  }
});

const createPayment = (token, body) => ctx.api(token).post("/api/payment/create-order").send({ shippingAddress: SHIPPING, ...body });

// ─── B1 ──────────────────────────────────────────────────────────────────────

describe("B1 · /api/payment/create-order did not validate items or quantity (fixed)", () => {
  it("B1a: a negative quantity is refused", async () => {
    await seedCatalog();
    const c = await makeCustomer();
    const res = await createPayment(c.token, { items: [{ productId: "gold-ring", quantity: 1 }, { productId: "silver-anklet", quantity: -2 }] });
    expect(res.status).toBe(400);
  });

  it("B1a: a negative line charges nothing, reserves nothing, adds no stock, never reaches Razorpay", async () => {
    await seedCatalog();
    const c = await makeCustomer();
    const res = await createPayment(c.token, { items: [{ productId: "gold-ring", quantity: 1 }, { productId: "silver-anklet", quantity: -2 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least 1/);
    expect(await stockOf("silver-anklet")).toBe(5);
    expect(await stockOf("gold-ring")).toBe(5);
    expect(mocks().razorpayCreate).not.toHaveBeenCalled();
    expect(await Order.countDocuments()).toBe(0);
  });

  it("B1b: a fractional quantity is refused", async () => {
    await seedCatalog();
    const c = await makeCustomer();
    const res = await createPayment(c.token, { items: [{ productId: "gold-ring", quantity: 0.01 }] });
    expect(res.status).toBe(400);
  });

  it("B1b: quantity 0.01 no longer buys the ring for 1% of its price", async () => {
    await seedCatalog();
    const c = await makeCustomer();
    const res = await createPayment(c.token, { items: [{ productId: "gold-ring", quantity: 0.01 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/whole number/);
    expect(await stockOf("gold-ring")).toBe(5);
    expect(mocks().razorpayCreate).not.toHaveBeenCalled();
  });

  it.each([[0], [100], ["abc"], [null], [1.5]])("B1: quantity %j → 400 on the card route", async (quantity) => {
    await seedCatalog();
    const c = await makeCustomer();
    const res = await createPayment(c.token, { items: [{ productId: "gold-ring", quantity }] });
    expect(res.status).toBe(400);
    expect(mocks().razorpayCreate).not.toHaveBeenCalled();
  });

  it.each([[1], [99], ["2"]])("B1: quantity %j is accepted on the card route and charged per piece", async (quantity) => {
    await seedRates();
    await createProduct("gold", { stock: 200 });
    const c = await makeCustomer();
    const res = await createPayment(c.token, { items: [{ productId: "gold-ring", quantity }] });
    expect(res.status).toBe(200);
    expect(res.body.amount).toBe(80752 * Number(quantity));
  });

  it("B1: the COD route shares the same line rules (100 → 400)", async () => {
    await seedCatalog();
    const c = await makeCustomer();
    const res = await ctx.api(c.token).post("/api/orders").send({ items: [{ productId: "gold-ring", quantity: 100 }], paymentMethod: "cod" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot exceed 99/);
  });

  it("B1c (ok): an item without productId is refused", async () => {
    await seedCatalog();
    const c = await makeCustomer();
    const res = await createPayment(c.token, { items: [{}] });
    expect(res.status).toBe(400);
  });

  it("B1d (ok): items that is not an array is refused with 400", async () => {
    await seedCatalog();
    const c = await makeCustomer();
    const res = await createPayment(c.token, { items: "gold-ring" });
    expect(res.status).toBe(400);
  });
});

// ─── B2 ──────────────────────────────────────────────────────────────────────

describe("B2 · the discount the product page showed was not what checkout charged (fixed)", () => {
  const page = async (id) => (await ctx.api().get(`/api/products/${id}`)).body.data;
  const rows = (b) => b.metalValue + b.wastageValue - b.discount + b.gst;

  it("B2: charged unit price equals the price the product page displays", async () => {
    await seedRates();
    await createProduct("gold", { discountPercentage: 10 });
    const c = await makeCustomer();
    const shown = await page("gold-ring");
    // DynamicProduct.jsx: `const finalPrice = dynamicProduct.discountPrice || dynamicProduct.price`
    const displayed = shown.discountPrice || shown.price;
    const order = await ctx.api(c.token).post("/api/orders").send({ items: [{ productId: "gold-ring" }], paymentMethod: "cod" });
    expect(order.body.data.items[0].unitPrice).toBe(displayed);
    expect(displayed).toBe(72677);
  });

  it.each([
    ["discounted", { discountPercentage: 10 }],
    ["undiscounted", {}],
    ["undiscounted, where rounding each row drifted by ₹1", { weight: 1.02, wastagePercent: 8 }],
  ])("B2: the page's breakdown rows sum to what BOTH checkout routes charge — %s", async (_label, over) => {
    await seedRates({ gold: 7001 });
    await createProduct("gold", over);
    const c = await makeCustomer();
    const shown = await page("gold-ring");
    expect(rows(shown.priceBreakdown)).toBe(shown.price);
    const cod = await ctx.api(c.token).post("/api/orders").send({ items: [{ productId: "gold-ring", quantity: 2 }], paymentMethod: "cod" });
    expect(cod.body.data.totalAmount).toBe(shown.price * 2);
    expect(cod.body.data.gstAmount).toBe(shown.priceBreakdown.gst * 2);
    const card = await createPayment(c.token, { items: [{ productId: "gold-ring" }] });
    expect(card.body.amount).toBe(shown.price);
  });

  it("B2: the cart charges the discounted price too", async () => {
    await seedRates();
    await createProduct("gold", { discountPercentage: 10 });
    const c = await makeCustomer();
    await ctx.api(c.token).post("/api/cart").send({ productId: "gold-ring", name: "Gold Ring" });
    expect((await ctx.api(c.token).get("/api/cart")).body[0].price).toBe(72677);
  });

  it("B2: discountPrice is calculated, never stored; a legacy stored value is ignored", async () => {
    const { token } = await makeAdmin();
    const res = await ctx.api(token).post("/api/products").send({ name: "Bangle", category: "Gold", weight: 10, discountPercentage: 10, discountPrice: 5 });
    expect(res.status).toBe(201);
    const { Product } = await import("../../server/models/Product.js");
    expect((await Product.findById(res.body.data._id).lean()).discountPrice).toBeUndefined();
    await seedRates();
    await createProduct("gold", { discountPrice: 899 }); // legacy making-charge-scale figure, no %
    const shown = await page("gold-ring");
    expect(shown.discountPrice).toBeUndefined();
    expect(shown.price).toBe(80752);
  });

  it("B2: the response carries the stored making charge, so an admin edit cannot overwrite it", async () => {
    await seedRates();
    await createProduct("gold", { price: 999 });
    const shown = await page("gold-ring");
    expect(shown.storedPrice).toBe(999);
    expect(shown.price).toBe(80752);
  });

  it("B2: a weightless piece saved with a blank (null) or 0 price is refused at checkout, never sold for nothing", async () => {
    await seedRates();
    const c = await makeCustomer();
    for (const price of [null, 0]) {
      await createProduct("weightless", { productId: `box-${price}`, price });
      const res = await ctx.api(c.token).post("/api/orders").send({ items: [{ productId: `box-${price}` }], paymentMethod: "cod" });
      expect(res.status, String(price)).toBe(400);
      expect(res.body.error).toMatch(/no price set/);
    }
  });
});

// ─── B3 ──────────────────────────────────────────────────────────────────────

describe("B3 · a metal with NO rate document fell back to the stored price (fixed)", () => {
  const STALE_SHAPE = (metal) =>
    `Our ${metal} rate is being updated, so these items cannot be priced right now. Please try again shortly.`;
  const order = (token, items) => ctx.api(token).post("/api/orders").send({ items, paymentMethod: "cod" });

  it("B3a: POST /api/orders refuses a product whose metal has no rate", async () => {
    await seedRates({ silver: null });
    await createProduct("silver");
    const c = await makeCustomer();
    const res = await order(c.token, [{ productId: "silver-anklet" }]);
    expect(res.status).toBe(503);
  });

  it("B3a: the 503 has the stale-rate shape, names the metal, and nothing is sold for the ₹250 making charge", async () => {
    await seedRates({ silver: null });
    await createProduct("silver");
    const c = await makeCustomer();
    const res = await order(c.token, [{ productId: "silver-anklet" }]);
    expect(res.body).toEqual({ error: STALE_SHAPE("silver") });
    expect(await Order.countDocuments()).toBe(0);
    expect(await stockOf("silver-anklet")).toBe(5);
  });

  it("B3b: /api/payment/create-order refuses it too, before Razorpay", async () => {
    await seedRates({ silver: null });
    await createProduct("silver");
    const c = await makeCustomer();
    const res = await createPayment(c.token, { items: [{ productId: "silver-anklet" }] });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: STALE_SHAPE("silver") });
    expect(mocks().razorpayCreate).not.toHaveBeenCalled();
    expect(await stockOf("silver-anklet")).toBe(5);
  });

  it("B3: a rate stored as 0 counts as missing", async () => {
    await seedRates({ gold: 0 });
    await createProduct("gold");
    const c = await makeCustomer();
    expect((await order(c.token, [{ productId: "gold-ring" }])).body).toEqual({ error: STALE_SHAPE("gold") });
  });

  it("B3: only the metal without a rate is refused — silver still sells when gold is missing", async () => {
    await seedRates({ gold: null });
    await createProduct("gold");
    await createProduct("silver");
    const c = await makeCustomer();
    expect((await order(c.token, [{ productId: "silver-anklet" }])).body.data.totalAmount).toBe(5099);
    expect((await order(c.token, [{ productId: "gold-ring" }])).status).toBe(503);
  });

  it("B3 (kept): weight-0 still sells at its stored price with no rates at all", async () => {
    await createProduct("weightless");
    const c = await makeCustomer();
    expect((await order(c.token, [{ productId: "gift-box" }])).body.data.totalAmount).toBe(1500);
  });

  it("B3 (kept): quote-only is still a 400, even when its metal has no rate", async () => {
    await createProduct("quote");
    const c = await makeCustomer();
    const res = await order(c.token, [{ productId: "diamond-set" }]);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Quote-only/);
  });

  it("B3 (kept): isFixedPrice is still ignored — a missing rate refuses either way", async () => {
    await seedRates({ silver: null });
    await createProduct("silver", { isFixedPrice: true });
    const c = await makeCustomer();
    expect((await order(c.token, [{ productId: "silver-anklet" }])).status).toBe(503);
  });

  it("B3c: a weight-0 product with no stored price is a 400 with a clear message, not a 500", async () => {
    await seedRates();
    await createProduct("weightless", { price: undefined });
    const c = await makeCustomer();
    const cod = await order(c.token, [{ productId: "gift-box" }]);
    const card = await createPayment(c.token, { items: [{ productId: "gift-box" }] });
    for (const res of [cod, card]) {
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Gift Box cannot be ordered right now — it has no price set.");
    }
    expect(await stockOf("gift-box")).toBe(5);
  });
});

// ─── B4 ──────────────────────────────────────────────────────────────────────

describe("B4 · products accepted negative weight / stock / price (fixed for new writes)", () => {
  const create = async (body) =>
    ctx.api((await makeAdmin()).token).post("/api/products").send({ name: "n", category: "Gold", ...body });

  it("B4: negative weight is refused at product creation", async () => {
    const res = await create({ weight: -5, stock: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Weight cannot be negative");
  });

  it.each([
    [{ stock: -1 }, "Stock cannot be negative"],
    [{ stock: 2.5 }, "Stock must be a whole number"],
    [{ price: -1 }, "Price cannot be negative"],
    [{ weight: "-0.5" }, "Weight cannot be negative"],
  ])("B4: create %j → 400", async (body, msg) => {
    const res = await create(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(msg);
  });

  it("B4: the same bounds apply to updates", async () => {
    await createProduct("gold");
    const { token } = await makeAdmin();
    for (const body of [{ weight: -5 }, { stock: -1 }, { price: -10 }]) {
      expect((await ctx.api(token).patch("/api/products/gold-ring").send(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await ctx.api(token).get("/api/products/gold-ring")).body.data.weight).toBe(10);
  });

  it("B4 (kept): zero weight, zero stock and zero price are valid", async () => {
    const res = await create({ weight: 0, stock: 0, price: 0 });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ weight: 0, stock: 0, price: 0 });
  });

  // Residual, NOT fixed by B4: the bounds guard API writes only. A product
  // already stored with a negative weight still prices below zero.
  it("B4 (residual): a negative weight already in the database still prices negative and can be ordered", async () => {
    await seedRates();
    await createProduct("gold", { weight: -5 });
    const c = await makeCustomer();
    const res = await ctx.api(c.token).post("/api/orders").send({ items: [{ productId: "gold-ring" }], paymentMethod: "cod" });
    expect(res.status).toBe(201);
    expect(res.body.data.totalAmount).toBeLessThan(0);
  });
});

// ─── B5 ──────────────────────────────────────────────────────────────────────

describe("B5 · inactive products were still listed and orderable (fixed)", () => {
  const inactiveRing = async () => {
    await seedRates();
    await createProduct("gold", { isActive: false });
  };

  it("B5a: GET /api/products hides isActive:false products", async () => {
    await inactiveRing();
    const res = await ctx.api().get("/api/products");
    expect(res.body.data.map((p) => p.productId)).not.toContain("gold-ring");
  });

  it("B5a: search and filter hide them too, for guests and customers", async () => {
    await inactiveRing();
    const c = await makeCustomer();
    for (const [who, url] of [[null, "/api/products/search?q=ring"], [c.token, "/api/products/search"], [null, "/api/products/filter"]]) {
      const res = await ctx.api(who).get(url);
      const list = res.body.data ?? res.body;
      expect(list.map((p) => p.productId), url).not.toContain("gold-ring");
    }
  });

  it("B5a: the product page is a 404 for customers, but admins still see it (to switch it back on)", async () => {
    await inactiveRing();
    const c = await makeCustomer();
    const admin = await makeAdmin();
    expect((await ctx.api().get("/api/products/gold-ring")).status).toBe(404);
    expect((await ctx.api(c.token).get("/api/products/gold-ring")).status).toBe(404);
    expect((await ctx.api(admin.token).get("/api/products/gold-ring")).status).toBe(200);
    const list = (await ctx.api(admin.token).get("/api/products")).body.data;
    expect(list.find((p) => p.productId === "gold-ring")).toMatchObject({ isActive: false });
  });

  it("B5b: an inactive product cannot be ordered", async () => {
    await inactiveRing();
    const c = await makeCustomer();
    const res = await ctx.api(c.token).post("/api/orders").send({ items: [{ productId: "gold-ring" }], paymentMethod: "cod" });
    expect(res.status).toBe(400);
  });

  it("B5b: a bag or Buy Now holding it is refused on both routes, naming the piece, and nothing is reserved", async () => {
    await inactiveRing();
    const c = await makeCustomer();
    const cod = await ctx.api(c.token).post("/api/orders").send({ items: [{ productId: "gold-ring" }], paymentMethod: "cod", buyNow: true });
    const card = await createPayment(c.token, { items: [{ productId: "gold-ring" }] });
    for (const res of [cod, card]) {
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Gold Ring is no longer available. Please remove it from your order.");
    }
    expect(await stockOf("gold-ring")).toBe(5);
    expect(mocks().razorpayCreate).not.toHaveBeenCalled();
  });

  it("B5: it stays in wishlists, visibly marked unavailable (deleted products too)", async () => {
    await inactiveRing();
    await createProduct("silver");
    const c = await makeCustomer();
    for (const productId of ["gold-ring", "silver-anklet", "deleted-piece"]) {
      await ctx.api(c.token).post("/api/wishlist").send({ productId, name: productId });
    }
    const wl = (await ctx.api(c.token).get("/api/wishlist")).body;
    const by = Object.fromEntries(wl.map((w) => [w.productId, w.available]));
    expect(by).toEqual({ "gold-ring": false, "silver-anklet": true, "deleted-piece": false });
  });

  it("B5: switching it back on makes it visible and orderable again", async () => {
    await inactiveRing();
    const admin = await makeAdmin();
    const c = await makeCustomer();
    await ctx.api(admin.token).patch("/api/products/gold-ring").send({ isActive: true });
    expect((await ctx.api().get("/api/products/gold-ring")).status).toBe(200);
    expect((await ctx.api(c.token).post("/api/orders").send({ items: [{ productId: "gold-ring" }], paymentMethod: "cod" })).status).toBe(201);
  });
});

// ─── B6 ──────────────────────────────────────────────────────────────────────

describe("B6 · dashboard revenue figures disagreed with each other (fixed — utils/revenue.js)", () => {
  it("B6a: /revenue counts delivered COD orders", async () => {
    const admin = await makeAdmin();
    await insertOrder({ paymentMethod: "cod", paymentStatus: "unpaid", orderStatus: "delivered", totalAmount: 50000 });
    const rev = (await ctx.api(admin.token).get("/api/admin-dashboard/revenue")).body.data;
    expect(rev.reduce((s, r) => s + r.totalRevenue, 0)).toBe(50000);
  });

  it("B6b: /stats totalRevenue excludes expired, rejected and never-paid online orders", async () => {
    const admin = await makeAdmin();
    await insertOrder({ totalAmount: 1000, orderStatus: "delivered" });
    await insertOrder({ totalAmount: 7777, orderStatus: "expired", paymentMethod: "razorpay", paymentStatus: "expired" });
    await insertOrder({ totalAmount: 8888, approvalStatus: "REJECTED" });
    const stats = (await ctx.api(admin.token).get("/api/admin-dashboard/stats")).body;
    expect(stats.totalRevenue).toBe(1000);
  });

  it("B6c: /admin/total-spent excludes cancelled and expired orders", async () => {
    const admin = await makeAdmin();
    await insertOrder({ userId: "u1", totalAmount: 1000, orderStatus: "delivered" });
    await insertOrder({ userId: "u1", totalAmount: 5000, orderStatus: "cancelled" });
    await insertOrder({ userId: "u1", totalAmount: 5000, orderStatus: "expired" });
    const rows = (await ctx.api(admin.token).get("/api/admin/total-spent")).body;
    expect(rows[0].totalSpent).toBe(1000);
  });

  it("B6: all four revenue figures agree on one mixed set of orders", async () => {
    const admin = await makeAdmin();
    const counted = [
      { userId: "u1", paymentMethod: "razorpay", paidAt: new Date(), paymentStatus: "paid", totalAmount: 30000 }, // paid online
      { userId: "u2", paymentMethod: "cod", orderStatus: "delivered", totalAmount: 20000 }, // delivered COD
      { userId: "u2", paymentMethod: "COD", orderStatus: "delivered", totalAmount: 5000 }, // legacy casing
    ];
    const notCounted = [
      { userId: "u3", paymentMethod: "cod", orderStatus: "processing", totalAmount: 111 }, // COD not delivered
      { userId: "u3", paymentMethod: "razorpay", paymentStatus: "pending", orderStatus: "pending", totalAmount: 222 }, // unpaid online
      { userId: "u3", paymentMethod: "razorpay", paidAt: new Date(), orderStatus: "cancelled", refundRequired: true, totalAmount: 333 },
      { userId: "u3", paymentMethod: "razorpay", paidAt: new Date(), orderStatus: "expired", totalAmount: 444 },
      { userId: "u3", paymentMethod: "razorpay", paidAt: new Date(), approvalStatus: "REJECTED", totalAmount: 555 },
    ];
    for (const o of [...counted, ...notCounted]) await insertOrder(o);
    const get = async (url) => (await ctx.api(admin.token).get(url)).body;
    const chart = (await get("/api/admin-dashboard/revenue")).data.reduce((s, r) => s + r.totalRevenue, 0);
    const stats = (await get("/api/admin-dashboard/stats")).totalRevenue;
    const trend = (await get("/api/admin-dashboard/income-stats")).reduce((s, r) => s + r.income, 0);
    const perCustomer = (await get("/api/admin/total-spent")).reduce((s, r) => s + r.totalSpent, 0);
    expect({ chart, stats, trend, perCustomer }).toEqual({ chart: 55000, stats: 55000, trend: 55000, perCustomer: 55000 });
  });
});

// ─── B7 ──────────────────────────────────────────────────────────────────────

describe("B7 · user input was compiled into regular expressions (fixed)", () => {
  it.each([
    ["/api/products/filter?category=("],
    ["/api/products/filter?search=("],
    ["/api/products/search?q=("],
    ["/api/products?category=("],
    ["/api/products/search?q=(a%2B)%2B%24"],
    ["/api/products/search?q=a&q=b"],
  ])("B7: %s → not a 500", async (url) => {
    await seedCatalog();
    const res = await ctx.api().get(url);
    expect(res.status).toBeLessThan(500);
  });

  it("B7: search text is matched literally — metacharacters match themselves, not patterns", async () => {
    await seedRates();
    await createProduct("gold", { productId: "paren", name: "Ring (22K)" });
    await createProduct("silver", { productId: "plain", name: "Ring 22K" });
    const hit = (await ctx.api().get("/api/products/search?q=" + encodeURIComponent("(22K)"))).body.data;
    expect(hit.map((p) => p.productId)).toEqual(["paren"]);
    // "." is a literal dot, not "any character".
    expect((await ctx.api().get("/api/products/search?q=Ring.22K")).body.data).toEqual([]);
  });

  it("B7: ordinary searches and category filters still work, case-insensitively", async () => {
    await seedCatalog();
    expect((await ctx.api().get("/api/products/search?q=ANKLET")).body.data.map((p) => p.productId)).toEqual(["silver-anklet"]);
    expect((await ctx.api().get("/api/products/filter?category=silver")).body.map((p) => p.productId)).toEqual(["silver-anklet"]);
    expect((await ctx.api().get("/api/products?category=Gold")).body.data).toHaveLength(2);
  });
});

// ─── B8 ──────────────────────────────────────────────────────────────────────

describe("B8 · /api/payment/verify confirmed before it checked ownership (fixed)", () => {
  it("B8: after a refused intruder, the owner's verify still confirms it — once, with one alert", async () => {
    await seedCatalog();
    const owner = await makeCustomer();
    const intruder = await makeCustomer();
    const created = await createPayment(owner.token, { items: [{ productId: "gold-ring" }] });
    const rzp = created.body.razorpayOrderId;
    const body = { razorpay_order_id: rzp, razorpay_payment_id: "pay_X", razorpay_signature: razorpaySignature(rzp, "pay_X") };
    expect((await ctx.api(intruder.token).post("/api/payment/verify").send(body)).status).toBe(403);
    expect(mocks().whatsapp.sendOrderAlert).not.toHaveBeenCalled();
    const ok = await ctx.api(owner.token).post("/api/payment/verify").send(body);
    expect(ok.status).toBe(200);
    expect(ok.body.message).toBe("Payment verified successfully");
    expect(mocks().whatsapp.sendOrderAlert).toHaveBeenCalledTimes(1);
  });

  it("B8: a 403'd verify leaves the order untouched", async () => {
    await seedCatalog();
    const owner = await makeCustomer();
    const intruder = await makeCustomer();
    const created = await createPayment(owner.token, { items: [{ productId: "gold-ring" }] });
    const rzp = created.body.razorpayOrderId;
    const res = await ctx.api(intruder.token).post("/api/payment/verify").send({
      razorpay_order_id: rzp,
      razorpay_payment_id: "pay_X",
      razorpay_signature: razorpaySignature(rzp, "pay_X"),
    });
    expect(res.status).toBe(403);
    expect((await Order.findById(created.body.orderId).lean()).paidAt).toBeNull();
  });
});

// ─── B9–B11 · rate limiting ──────────────────────────────────────────────────

describe("B9–B11 · rate limiting gaps (NODE_ENV=production)", () => {
  const prod = () => setEnv("NODE_ENV", "production");

  it("B9: the cap is per IP and per distinct address: 10 addresses pass, the 11th is refused with Retry-After, repeats are free, another IP is unaffected", async () => {
    prod();
    const addresses = Array.from({ length: 11 }, () => uniqueEmail("cap"));
    const send = (email, opts) => ctx.api(null, opts).post("/api/auth/otp/request").send({ email });
    for (const a of addresses.slice(0, 10)) expect((await send(a)).status).toBe(200);
    const sentBefore = mocks().resendSend.mock.calls.length;
    const refused = await send(addresses[10]);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
    expect(mocks().resendSend.mock.calls.length).toBe(sentBefore);
    // Asking again for an address already counted is not a new recipient.
    expect((await send(addresses[0])).status).toBe(200);
    // The cap belongs to that IP: another connection can still send to it.
    expect((await send(addresses[10], { ip: "198.51.100.9" })).status).toBe(200);
  });

  it("B9: one IP cannot trigger sign-in emails to an unlimited number of addresses", async () => {
    prod();
    const statuses = [];
    for (let i = 0; i < 25; i++) statuses.push((await ctx.api().post("/api/auth/otp/request").send({ email: uniqueEmail("victim") })).status);
    expect(statuses).toContain(429);
  });

  it("B10: refresh still has its own limit — the 61st refresh attempt from one IP is refused", async () => {
    prod();
    const statuses = [];
    for (let i = 0; i < 61; i++) statuses.push((await ctx.api().post("/api/auth/refresh").send({ refreshToken: "f".repeat(80) })).status);
    expect(statuses.slice(0, 60)).not.toContain(429);
    expect(statuses[60]).toBe(429);
  });

  it("B10: refresh attempts do not use up the login allowance either", async () => {
    prod();
    for (let i = 0; i < 15; i++) await ctx.api().post("/api/auth/refresh").send({ refreshToken: "f".repeat(80) });
    expect((await ctx.api().post("/api/auth/login").send({ email: "x@y.co", password: "bad" })).status).toBe(401);
  });

  it("B10: failed admin logins from an IP do not block customers' silent token refresh from that IP", async () => {
    prod();
    const phone = uniquePhone();
    await User.create({ phone: `+91${phone}`, role: "USER" });
    const { RefreshToken } = await import("../../server/models/RefreshToken.js");
    const crypto = await import("node:crypto");
    const raw = "a".repeat(80);
    const u = await User.findOne({ phone: `+91${phone}` });
    await RefreshToken.create({ userId: u._id, tokenHash: crypto.createHash("sha256").update(raw).digest("hex"), expiresAt: new Date(Date.now() + 86400000) });
    for (let i = 0; i < 10; i++) await ctx.api().post("/api/auth/login").send({ email: "x@y.co", password: "bad" });
    const refresh = await ctx.api().post("/api/auth/refresh").send({ refreshToken: raw });
    expect(refresh.status).toBe(200);
  });

  it("B11: /api/auth/register is still limited — the 11th attempt from one IP is refused", async () => {
    prod();
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await ctx.api().post("/api/auth/register").send({ email: `r${i}@x.co`, password: "secret12" })).status);
    expect(statuses.slice(0, 10)).not.toContain(429);
    expect(statuses[10]).toBe(429);
  });

  it("B11: /api/auth/register is counted once per request (it was limited twice)", async () => {
    prod();
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await ctx.api().post("/api/auth/register").send({ email: `r${i}@x.co`, password: "secret12" })).status);
    expect(statuses[5]).not.toBe(429);
  });
});

// ─── B12 ─────────────────────────────────────────────────────────────────────

describe("B12 · OTP hashes were returned by user endpoints (fixed)", () => {
  it("B12a: GET /api/users/me omits otpHash", async () => {
    const c = await makeCustomer({ otpHash: "$2b$12$x", otpExpiresAt: new Date() });
    const res = await ctx.api(c.token).get("/api/users/me");
    expect(res.body.data.otpHash).toBeUndefined();
  });

  it("B12: no self-service response carries the code hash, its expiry or a password hash", async () => {
    const c = await makeCustomer({ otpHash: "$2b$12$x", otpExpiresAt: new Date(Date.now() + 60000), passwordHash: "$2b$12$p" });
    const responses = [
      await ctx.api(c.token).get("/api/users/me"),
      await ctx.api(c.token).patch("/api/users/me").send({ name: "N" }),
      await ctx.api(c.token).patch("/api/users/shipping-address").send(SHIPPING),
      await ctx.api(c.token).patch("/api/users/delete-address"),
    ];
    for (const r of responses) {
      expect(r.status).toBe(200);
      for (const f of ["otpHash", "otpExpiresAt", "passwordHash"]) expect(r.body.data[f], `${r.req.path} ${f}`).toBeUndefined();
    }
  });

  it("B12b: GET /api/users (admin) omits every customer's otpHash", async () => {
    const admin = await makeAdmin();
    await makeCustomer({ otpHash: "$2b$12$x", otpExpiresAt: new Date(Date.now() + 60000) });
    const res = await ctx.api(admin.token).get("/api/users");
    expect(res.body.every((u) => u.otpHash === undefined)).toBe(true);
  });
});

// ─── B13–B14 · cart ──────────────────────────────────────────────────────────

describe("B13–B14 · cart", () => {
  it("B13: repeated adds cannot push a line past 99", async () => {
    const c = await makeCustomer();
    await ctx.api(c.token).post("/api/cart").send({ productId: "gold-ring", name: "R", quantity: 60 });
    await ctx.api(c.token).post("/api/cart").send({ productId: "gold-ring", name: "R", quantity: 60 });
    expect((await Cart.findOne({}).lean()).quantity).toBeLessThanOrEqual(99);
  });

  it("B13: the add that would cross 99 is refused with a message and the line is unchanged", async () => {
    const c = await makeCustomer();
    await ctx.api(c.token).post("/api/cart").send({ productId: "gold-ring", name: "R", quantity: 60 });
    const res = await ctx.api(c.token).post("/api/cart").send({ productId: "gold-ring", name: "R", quantity: 40 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at most 99 .* already have 60/);
    expect((await Cart.findOne({}).lean()).quantity).toBe(60);
    // Exactly 99 is fine.
    expect((await ctx.api(c.token).post("/api/cart").send({ productId: "gold-ring", name: "R", quantity: 39 })).status).toBe(200);
    expect((await Cart.findOne({}).lean()).quantity).toBe(99);
  });

  bug("B14: a product that does not exist cannot be added", async () => {
    const c = await makeCustomer();
    const res = await ctx.api(c.token).post("/api/cart").send({ productId: "ghost", name: "Ghost", price: 1 });
    expect(res.status).toBe(404);
  });
});

// ─── B15 ─────────────────────────────────────────────────────────────────────

describe("B15 · password reset token is not claimed atomically", () => {
  bug("B15: two concurrent resets with one token → exactly one succeeds", async () => {
    const admin = await makeAdmin();
    await ctx.api().post("/api/auth/password/forgot").send({ email: admin.user.email });
    const html = mocks().resendSend.mock.calls.at(-1)[0].html;
    const token = html.match(/token=([0-9a-f]{64})/)[1];
    const results = await Promise.all(
      ["FirstNewPass!1", "SecondNewPass!2"].map((password) => ctx.api().post("/api/auth/password/reset").send({ token, password }))
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });
});

// ─── B16 ─────────────────────────────────────────────────────────────────────

describe("B16 · duplicate keys surface as 500", () => {
  bug("B16a: duplicate productId → 409", async () => {
    await seedCatalog();
    const { token } = await makeAdmin();
    const res = await ctx.api(token).post("/api/products").send({ productId: "gold-ring", name: "n", category: "Gold" });
    expect(res.status).toBe(409);
  });

  bug("B16b: duplicate categoryName → 409", async () => {
    const { token } = await makeAdmin();
    await Category.create({ categoryName: "Gold" });
    const res = await ctx.api(token).post("/api/categories").send({ categoryName: "Gold" });
    expect(res.status).toBe(409);
  });
});

// ─── B17 ─────────────────────────────────────────────────────────────────────

describe("B17 · z.coerce.boolean() reads the string 'false' as true", () => {
  bug("B17a: isQuoteOnly:'false' creates a priced product", async () => {
    const { token } = await makeAdmin();
    const res = await ctx.api(token).post("/api/products").send({ name: "n", category: "Gold", isQuoteOnly: "false" });
    expect(res.body.data.isQuoteOnly).toBe(false);
  });

  bug("B17b: buyNow:'false' still clears the cart", async () => {
    await seedCatalog();
    const c = await makeCustomer();
    await ctx.api(c.token).post("/api/cart").send({ productId: "silver-anklet", name: "A" });
    await ctx.api(c.token).post("/api/orders").send({ items: [{ productId: "gold-ring" }], paymentMethod: "cod", buyNow: "false" });
    expect(await Cart.countDocuments({ userId: String(c.user._id) })).toBe(0);
  });
});

// ─── B18 ─────────────────────────────────────────────────────────────────────

describe("B18 · approving a cancelled order (fixed — utils/orderStatus.js)", () => {
  it("B18: a customer-cancelled order cannot then be approved by the owner", async () => {
    await seedCatalog();
    const c = await makeCustomer();
    const admin = await makeAdmin();
    const placed = await ctx.api(c.token).post("/api/orders").send({ items: [{ productId: "gold-ring" }], paymentMethod: "cod" });
    await ctx.api(c.token).patch(`/api/orders/${placed.body.data._id}/cancel`);
    const res = await ctx.api(admin.token).patch(`/api/orders/${placed.body.data._id}/approval`).send({ approvalStatus: "APPROVED" });
    expect(res.status).toBe(400);
  });
});
