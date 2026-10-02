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

describe("B1 · /api/payment/create-order does not validate items or quantity", () => {
  bug("B1a: a negative quantity is refused", async () => {
    await seedCatalog();
    const c = await makeCustomer();
    const res = await createPayment(c.token, { items: [{ productId: "gold-ring", quantity: 1 }, { productId: "silver-anklet", quantity: -2 }] });
    expect(res.status).toBe(400);
  });

  it("B1a (impact): a negative line lowers the amount charged AND adds phantom stock", async () => {
    await seedCatalog();
    const c = await makeCustomer();
    const res = await createPayment(c.token, { items: [{ productId: "gold-ring", quantity: 1 }, { productId: "silver-anklet", quantity: -2 }] });
    expect(res.status).toBe(200);
    expect(res.body.amount).toBe(80752 - 2 * 5099); // ₹70,554 for an ₹80,752 ring
    expect(await stockOf("silver-anklet")).toBe(7); // was 5
    expect(await stockOf("gold-ring")).toBe(4);
  });

  bug("B1b: a fractional quantity is refused", async () => {
    await seedCatalog();
    const c = await makeCustomer();
    const res = await createPayment(c.token, { items: [{ productId: "gold-ring", quantity: 0.01 }] });
    expect(res.status).toBe(400);
  });

  it("B1b (impact): quantity 0.01 buys the ring for 1% of its price", async () => {
    await seedCatalog();
    const c = await makeCustomer();
    const res = await createPayment(c.token, { items: [{ productId: "gold-ring", quantity: 0.01 }] });
    expect(res.body.amount).toBe(808);
    expect(await stockOf("gold-ring")).toBeCloseTo(4.99, 5);
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

describe("B2 · the discount the product page shows is not what checkout charges", () => {
  bug("B2: charged unit price equals the price the product page displays", async () => {
    await seedRates();
    await createProduct("gold", { discountPercentage: 10 });
    const c = await makeCustomer();
    const page = (await ctx.api().get("/api/products/gold-ring")).body.data;
    // DynamicProduct.jsx: `const finalPrice = dynamicProduct.discountPrice || dynamicProduct.price`
    const shown = page.discountPrice || page.price;
    const order = await ctx.api(c.token).post("/api/orders").send({ items: [{ productId: "gold-ring" }], paymentMethod: "cod" });
    expect(order.body.data.items[0].unitPrice).toBe(Math.round(shown));
  });
});

// ─── B3 ──────────────────────────────────────────────────────────────────────

describe("B3 · a metal with NO rate document falls back to the stored price", () => {
  bug("B3a: POST /api/orders refuses a product whose metal has no rate", async () => {
    await seedRates({ silver: null });
    await createProduct("silver");
    const c = await makeCustomer();
    const res = await ctx.api(c.token).post("/api/orders").send({ items: [{ productId: "silver-anklet" }], paymentMethod: "cod" });
    expect(res.status).toBe(503);
  });

  it("B3a (impact): the 50 g silver anklet is sold for its ₹250 making charge", async () => {
    await seedRates({ silver: null });
    await createProduct("silver");
    const c = await makeCustomer();
    const res = await ctx.api(c.token).post("/api/orders").send({ items: [{ productId: "silver-anklet" }], paymentMethod: "cod" });
    expect(res.body.data.totalAmount).toBe(250);
  });

  bug("B3b: /api/payment/create-order refuses it too", async () => {
    await seedRates({ silver: null });
    await createProduct("silver");
    const c = await makeCustomer();
    const res = await createPayment(c.token, { items: [{ productId: "silver-anklet" }] });
    expect(res.status).toBe(503);
  });

  bug("B3c: a weight-0 product with no stored price is a 4xx, not a 500", async () => {
    await seedRates();
    await createProduct("weightless", { price: undefined });
    const c = await makeCustomer();
    const res = await ctx.api(c.token).post("/api/orders").send({ items: [{ productId: "gift-box" }], paymentMethod: "cod" });
    expect(res.status).toBeLessThan(500);
  });
});

// ─── B4 ──────────────────────────────────────────────────────────────────────

describe("B4 · products accept negative weight / stock / price", () => {
  bug("B4: negative weight is refused at product creation", async () => {
    const { token } = await makeAdmin();
    const res = await ctx.api(token).post("/api/products").send({ name: "n", category: "Gold", weight: -5, stock: 1 });
    expect(res.status).toBe(400);
  });

  it("B4 (impact): a negative-weight product has a negative price and can be ordered", async () => {
    await seedRates();
    await createProduct("gold", { weight: -5 });
    const c = await makeCustomer();
    const res = await ctx.api(c.token).post("/api/orders").send({ items: [{ productId: "gold-ring" }], paymentMethod: "cod" });
    expect(res.status).toBe(201);
    expect(res.body.data.totalAmount).toBeLessThan(0);
  });
});

// ─── B5 ──────────────────────────────────────────────────────────────────────

describe("B5 · inactive products are still listed and orderable", () => {
  bug("B5a: GET /api/products hides isActive:false products", async () => {
    await seedRates();
    await createProduct("gold", { isActive: false });
    const res = await ctx.api().get("/api/products");
    expect(res.body.data.map((p) => p.productId)).not.toContain("gold-ring");
  });

  bug("B5b: an inactive product cannot be ordered", async () => {
    await seedRates();
    await createProduct("gold", { isActive: false });
    const c = await makeCustomer();
    const res = await ctx.api(c.token).post("/api/orders").send({ items: [{ productId: "gold-ring" }], paymentMethod: "cod" });
    expect(res.status).toBe(400);
  });
});

// ─── B6 ──────────────────────────────────────────────────────────────────────

describe("B6 · dashboard revenue figures disagree with each other", () => {
  bug("B6a: /revenue counts delivered COD orders", async () => {
    const admin = await makeAdmin();
    await insertOrder({ paymentMethod: "cod", paymentStatus: "unpaid", orderStatus: "delivered", totalAmount: 50000 });
    const rev = (await ctx.api(admin.token).get("/api/admin-dashboard/revenue")).body.data;
    expect(rev.reduce((s, r) => s + r.totalRevenue, 0)).toBe(50000);
  });

  bug("B6b: /stats totalRevenue excludes expired, rejected and never-paid online orders", async () => {
    const admin = await makeAdmin();
    await insertOrder({ totalAmount: 1000, orderStatus: "delivered" });
    await insertOrder({ totalAmount: 7777, orderStatus: "expired", paymentMethod: "razorpay", paymentStatus: "expired" });
    await insertOrder({ totalAmount: 8888, approvalStatus: "REJECTED" });
    const stats = (await ctx.api(admin.token).get("/api/admin-dashboard/stats")).body;
    expect(stats.totalRevenue).toBe(1000);
  });

  bug("B6c: /admin/total-spent excludes cancelled and expired orders", async () => {
    const admin = await makeAdmin();
    await insertOrder({ userId: "u1", totalAmount: 1000 });
    await insertOrder({ userId: "u1", totalAmount: 5000, orderStatus: "cancelled" });
    await insertOrder({ userId: "u1", totalAmount: 5000, orderStatus: "expired" });
    const rows = (await ctx.api(admin.token).get("/api/admin/total-spent")).body;
    expect(rows[0].totalSpent).toBe(1000);
  });
});

// ─── B7 ──────────────────────────────────────────────────────────────────────

describe("B7 · user input is compiled into regular expressions", () => {
  bug.each([
    ["/api/products/filter?category=("],
    ["/api/products/filter?search=("],
    ["/api/products/search?q=("],
    ["/api/products?category=("],
  ])("B7: %s → not a 500", async (url) => {
    await seedCatalog();
    const res = await ctx.api().get(url);
    if (res.status >= 500) throw new Error(`500 for ${url}`);
  });
});

// ─── B8 ──────────────────────────────────────────────────────────────────────

describe("B8 · /api/payment/verify confirms before it checks ownership", () => {
  bug("B8: a 403'd verify leaves the order untouched", async () => {
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
  const prod = () => {
    setEnv("NODE_ENV", "production");
    setEnv("MSG91_AUTH_KEY", "k");
    setEnv("MSG91_TEMPLATE_ID", "t");
  };

  bug("B9: one IP cannot trigger OTP SMS to an unlimited number of phones", async () => {
    prod();
    const statuses = [];
    for (let i = 0; i < 25; i++) statuses.push((await ctx.api().post("/api/auth/otp/request").send({ phone: uniquePhone() })).status);
    expect(statuses).toContain(429);
  });

  bug("B10: failed admin logins from an IP do not block customers' silent token refresh from that IP", async () => {
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

  bug("B11: /api/auth/register is counted once per request (it is limited twice)", async () => {
    prod();
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await ctx.api().post("/api/auth/register").send({ email: `r${i}@x.co`, password: "secret12" })).status);
    expect(statuses[5]).not.toBe(429);
  });
});

// ─── B12 ─────────────────────────────────────────────────────────────────────

describe("B12 · OTP hashes are returned by user endpoints", () => {
  bug("B12a: GET /api/users/me omits otpHash", async () => {
    const c = await makeCustomer({ otpHash: "$2b$12$x", otpExpiresAt: new Date() });
    const res = await ctx.api(c.token).get("/api/users/me");
    expect(res.body.data.otpHash).toBeUndefined();
  });

  bug("B12b: GET /api/users (admin) omits every customer's otpHash", async () => {
    const admin = await makeAdmin();
    await makeCustomer({ otpHash: "$2b$12$x", otpExpiresAt: new Date(Date.now() + 60000) });
    const res = await ctx.api(admin.token).get("/api/users");
    expect(res.body.every((u) => u.otpHash === undefined)).toBe(true);
  });
});

// ─── B13–B14 · cart ──────────────────────────────────────────────────────────

describe("B13–B14 · cart", () => {
  bug("B13: repeated adds cannot push a line past 99", async () => {
    const c = await makeCustomer();
    await ctx.api(c.token).post("/api/cart").send({ productId: "gold-ring", name: "R", quantity: 60 });
    await ctx.api(c.token).post("/api/cart").send({ productId: "gold-ring", name: "R", quantity: 60 });
    expect((await Cart.findOne({}).lean()).quantity).toBeLessThanOrEqual(99);
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

describe("B18 · approving a cancelled order", () => {
  bug("B18: a customer-cancelled order cannot then be approved by the owner", async () => {
    await seedCatalog();
    const c = await makeCustomer();
    const admin = await makeAdmin();
    const placed = await ctx.api(c.token).post("/api/orders").send({ items: [{ productId: "gold-ring" }], paymentMethod: "cod" });
    await ctx.api(c.token).patch(`/api/orders/${placed.body.data._id}/cancel`);
    const res = await ctx.api(admin.token).patch(`/api/orders/${placed.body.data._id}/approval`).send({ approvalStatus: "APPROVED" });
    expect(res.status).toBe(400);
  });
});
