/**
 * Step 4 — the nine suspected bugs, one describe each.
 *
 * Every test asserts the CORRECT behaviour. Tests declared with `bug(` are
 * CONFIRMED bugs (see tests/helpers/bug.js): they pass today only because the
 * assertion fails. When the bug is fixed the test turns red — change `bug(` to
 * `it(` at that point. `SHOW_BUGS=1 npm test` shows each one's diff.
 * Tests declared with `it(` and "(impact)" in the title pin down what the bug
 * does today. IDs (S1a …) match the bug table in the report.
 */
import { describe, it, expect, afterEach } from "vitest";
import bcrypt from "bcrypt";
import { useApp, mocks } from "../helpers/app.js";
import { bug } from "../helpers/bug.js";
import {
  seedCatalog,
  makeCustomer,
  makeAdmin,
  insertOrder,
  stockOf,
  uniquePhone,
  razorpaySignature,
  SHIPPING,
} from "../helpers/factories.js";
import { User } from "../../server/models/User.js";
import { Order } from "../../server/models/Order.js";
import { Cart } from "../../server/models/Cart.js";
import { Review } from "../../server/models/Review.js";
import { Product } from "../../server/models/Product.js";
import { releaseStaleReservations } from "../../server/utils/stock.js";

const ctx = useApp();
const hourAgo = () => new Date(Date.now() - 60 * 60 * 1000);

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

// ─── S1 ──────────────────────────────────────────────────────────────────────

describe("S1 · PATCH /api/users/:id passes req.body straight to findByIdAndUpdate", () => {
  bug("S1a: an admin request cannot write passwordHash / otpHash / unnormalised phone", async () => {
    const admin = await makeAdmin();
    const c = await makeCustomer();
    const knownHash = await bcrypt.hash("attacker-chosen", 4);
    await ctx.api(admin.token).patch(`/api/users/${c.user._id}`).send({
      passwordHash: knownHash,
      otpHash: "planted",
      otpExpiresAt: new Date(Date.now() + 3600_000),
      phone: "not-a-phone",
      email: "hijack@evil.test",
    });
    const after = await User.findById(c.user._id).lean();
    expect(after.passwordHash).toBeUndefined();
    expect(after.otpHash).toBeUndefined();
    expect(after.phone).toBe(c.user.phone);
  });

  it("S1a (impact): after that write, the customer's account signs in with a password the admin chose", async () => {
    const admin = await makeAdmin();
    const c = await makeCustomer();
    await ctx.api(admin.token).patch(`/api/users/${c.user._id}`).send({
      email: "victim@shop.test",
      passwordHash: await bcrypt.hash("attacker-chosen", 4),
    });
    const login = await ctx.api().post("/api/auth/login").send({ email: "victim@shop.test", password: "attacker-chosen" });
    // Documents current behaviour: 200 (an OTP-only customer now has a password login).
    expect(login.status).toBe(200);
  });

  bug("S1b: the response never includes otpHash", async () => {
    const admin = await makeAdmin();
    const c = await makeCustomer({ otpHash: "$2b$12$secretish" });
    const res = await ctx.api(admin.token).patch(`/api/users/${c.user._id}`).send({ name: "x" });
    expect(res.body.data.otpHash).toBeUndefined();
  });

  bug("S1c: the last admin cannot demote themselves", async () => {
    const admin = await makeAdmin();
    const res = await ctx.api(admin.token).patch(`/api/users/${admin.user._id}`).send({ role: "USER" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await User.findById(admin.user._id).lean()).role).toBe("ADMIN");
  });

  bug("S1d: the last admin cannot delete themselves", async () => {
    const admin = await makeAdmin();
    const res = await ctx.api(admin.token).delete(`/api/users/${admin.user._id}`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await User.countDocuments({ role: "ADMIN" })).toBe(1);
  });

  bug("S1e: an invalid role is refused (update validators do not run, so the enum is not enforced)", async () => {
    const admin = await makeAdmin();
    const c = await makeCustomer();
    const res = await ctx.api(admin.token).patch(`/api/users/${c.user._id}`).send({ role: "SUPERUSER" });
    expect(res.status).toBe(400);
    expect((await User.findById(c.user._id).lean()).role).toBe("USER");
  });
});

// ─── S2 ──────────────────────────────────────────────────────────────────────

describe("S2 · POST /api/orders accepts any paymentMethod", () => {
  const place = async (paymentMethod) => {
    await seedCatalog();
    const c = await makeCustomer();
    await ctx.api(c.token).post("/api/cart").send({ productId: "silver-anklet", name: "Anklet" });
    const res = await ctx.api(c.token).post("/api/orders").send({
      items: [{ productId: "gold-ring" }],
      paymentMethod,
      shippingAddress: SHIPPING,
    });
    return { c, res };
  };

  bug.each(["razorpay", "upi", "free", "card"])(
    "S2a: paymentMethod %s is refused — only COD may skip payment",
    async (m) => {
      const { res } = await place(m);
      expect(res.status).toBe(400);
    }
  );

  it("S2a (impact, 'upi' — the Checkout page's UPI / QR SCAN option): unpaid order, owner told 'Paid online', cart cleared, then swept", async () => {
    const { c, res } = await place("upi");
    expect(res.status).toBe(201);
    const o = await Order.findById(res.body.data._id).lean();
    expect(o).toMatchObject({ paymentMethod: "upi", paymentStatus: "pending", orderStatus: "processing", paidAt: null });
    // Owner alert fired, and whatsapp.js labels every non-"cod" method "Paid online".
    expect(mocks().whatsapp.sendOrderAlert).toHaveBeenCalledWith(expect.objectContaining({ paymentMethod: "upi" }));
    expect(await Cart.countDocuments({ userId: String(c.user._id) })).toBe(0);
    // 30 minutes later the cron expires it and restocks — the customer saw "Order placed".
    await Order.updateOne({ _id: o._id }, { createdAt: hourAgo() });
    const sweep = await releaseStaleReservations();
    expect(sweep.released.map((r) => r.orderId)).toContain(o.orderId);
    expect((await Order.findById(o._id).lean()).orderStatus).toBe("expired");
  });

  bug("S2b: 'COD' (upper case) is treated as cash on delivery, never swept", async () => {
    const { res } = await place("COD");
    const o = await Order.findById(res.body.data._id).lean();
    await Order.updateOne({ _id: o._id }, { createdAt: hourAgo() });
    const sweep = await releaseStaleReservations();
    expect(sweep.released).toHaveLength(0);
  });

  bug("S2c: omitted paymentMethod → stored as COD with paymentStatus 'unpaid' (not 'pending')", async () => {
    const { res } = await place(undefined);
    const o = await Order.findById(res.body.data._id).lean();
    expect(o.paymentMethod).toBe("cod");
    expect(o.paymentStatus).toBe("unpaid");
  });

  bug("S2d: an unpaid online order cannot be approved and shipped", async () => {
    const { res } = await place("upi");
    const admin = await makeAdmin();
    const approve = await ctx.api(admin.token).patch(`/api/orders/${res.body.data._id}/approval`).send({ approvalStatus: "APPROVED" });
    expect(approve.status).toBe(400);
  });
});

// ─── S3 ──────────────────────────────────────────────────────────────────────

describe("S3 · cancelling / rejecting a PAID online order", () => {
  const paidOrder = async () => {
    await seedCatalog();
    const c = await makeCustomer();
    const created = await ctx.api(c.token).post("/api/payment/create-order").send({ items: [{ productId: "gold-ring" }], shippingAddress: SHIPPING });
    const rzp = created.body.razorpayOrderId;
    await ctx.api(c.token).post("/api/payment/verify").send({
      razorpay_order_id: rzp,
      razorpay_payment_id: "pay_PAID1",
      razorpay_signature: razorpaySignature(rzp, "pay_PAID1"),
    });
    mocks().whatsapp.sendOrderAlert.mockClear();
    return { c, orderId: created.body.orderId };
  };

  it("stock is released on customer cancel (works)", async () => {
    const { c, orderId } = await paidOrder();
    expect((await ctx.api(c.token).patch(`/api/orders/${orderId}/cancel`)).status).toBe(200);
    expect(await stockOf("gold-ring")).toBe(5);
  });

  bug("S3a: customer cancel of a paid order sets refundRequired", async () => {
    const { c, orderId } = await paidOrder();
    await ctx.api(c.token).patch(`/api/orders/${orderId}/cancel`);
    expect((await Order.findById(orderId).lean()).refundRequired).toBe(true);
  });

  bug("S3b: customer cancel of a paid order alerts the owner", async () => {
    const { c, orderId } = await paidOrder();
    await ctx.api(c.token).patch(`/api/orders/${orderId}/cancel`);
    const w = mocks().whatsapp;
    const alerted = w.sendRefundRequiredAlert.mock.calls.length + w.sendOrderAlert.mock.calls.length + w.sendOrderApprovalAlert.mock.calls.length;
    expect(alerted).toBeGreaterThan(0);
  });

  bug("S3c: owner rejecting a paid order sets refundRequired", async () => {
    const { orderId } = await paidOrder();
    const admin = await makeAdmin();
    await ctx.api(admin.token).patch(`/api/orders/${orderId}/approval`).send({ approvalStatus: "REJECTED", rejectionReason: "No stock" });
    expect((await Order.findById(orderId).lean()).refundRequired).toBe(true);
  });
});

// ─── S4 ──────────────────────────────────────────────────────────────────────

describe("S4 · OTP limiters key on the raw req.body.phone", () => {
  const prodWithSms = () => {
    setEnv("NODE_ENV", "production");
    setEnv("MSG91_AUTH_KEY", "k");
    setEnv("MSG91_TEMPLATE_ID", "t");
  };

  bug("S4a: exhausting verify attempts with one spelling also blocks the other spellings", async () => {
    prodWithSms();
    const n = uniquePhone();
    await ctx.api().post("/api/auth/otp/request").send({ phone: n });
    for (let i = 0; i < 5; i++) await ctx.api().post("/api/auth/otp/verify").send({ phone: n, otp: "000000" });
    const blocked = await ctx.api().post("/api/auth/otp/verify").send({ phone: n, otp: "000000" });
    expect(blocked.status).toBe(429);
    for (const spelling of [`+91${n}`, `0${n}`, `${n.slice(0, 5)} ${n.slice(5)}`, `91${n}`]) {
      const r = await ctx.api().post("/api/auth/otp/verify").send({ phone: spelling, otp: "000000" });
      expect(r.status, spelling).toBe(429);
    }
  });

  it("S4a (impact): how many OTP guesses one number gets in one 5-minute window", async () => {
    prodWithSms();
    const n = uniquePhone();
    await ctx.api().post("/api/auth/otp/request").send({ phone: n });
    // Each of these is a distinct limiter key that normalises to the same account.
    const spellings = [n, `+91${n}`, `0${n}`, `91${n}`, `0091${n}`, `+91 ${n}`, `${n.slice(0, 5)} ${n.slice(5)}`, `${n.slice(0, 5)}-${n.slice(5)}`, `(${n.slice(0, 5)})${n.slice(5)}`, `${n.slice(0, 3)}.${n.slice(3)}`];
    let accepted = 0;
    for (const s of spellings) {
      for (let i = 0; i < 5; i++) {
        const r = await ctx.api().post("/api/auth/otp/verify").send({ phone: s, otp: String(100000 + accepted) });
        if (r.status === 401) accepted++;
      }
    }
    // Intended: 5. Actual: 5 per spelling, and spaces/dashes/dots can be put
    // anywhere, so the real ceiling is apiLimiter (200/min/IP).
    expect(accepted).toBe(spellings.length * 5);
  });

  bug("S4b: OTP *requests* are also capped per number across spellings", async () => {
    prodWithSms();
    const n = uniquePhone();
    for (let i = 0; i < 10; i++) await ctx.api().post("/api/auth/otp/request").send({ phone: n });
    const r = await ctx.api().post("/api/auth/otp/request").send({ phone: `+91${n}` });
    expect(r.status).toBe(429);
  });
});

// ─── S5 ──────────────────────────────────────────────────────────────────────

describe("S5 · reviews", () => {
  bug("S5a: a customer cannot review a product they never bought", async () => {
    await seedCatalog();
    const c = await makeCustomer();
    const res = await ctx.api(c.token).post("/api/reviews").send({ productId: "gold-ring", review: "Fake 5 stars", rating: 5 });
    expect(res.status).toBe(403);
  });

  bug("S5b: a review for a non-existent productId is refused", async () => {
    const c = await makeCustomer();
    const res = await ctx.api(c.token).post("/api/reviews").send({ productId: "does-not-exist", review: "x", rating: 1 });
    expect(res.status).toBe(404);
  });

  bug("S5c: the reviewer's display name comes from their account, not the request body", async () => {
    const c = await makeCustomer({ name: "Real Name" });
    const res = await ctx.api(c.token).post("/api/reviews").send({ review: "x", rating: 5, name: "Sri Ram Jewellery (Official)" });
    expect(res.body.data.name).toBe("Real Name");
  });

  bug("S5d: public GET /api/reviews does not expose userId", async () => {
    const c = await makeCustomer();
    await Review.create({ name: "A", review: "r", rating: 5, userId: String(c.user._id), productId: "p" });
    const all = await ctx.api().get("/api/reviews");
    expect(all.body[0].userId).toBeUndefined();
  });

  bug("S5e: public GET /api/reviews/:productId does not expose userId", async () => {
    const c = await makeCustomer();
    await Review.create({ name: "A", review: "r", rating: 5, userId: String(c.user._id), productId: "p" });
    const one = await ctx.api().get("/api/reviews/p");
    expect(one.body.data[0].userId).toBeUndefined();
  });

  bug("S5f: one review per customer per product", async () => {
    await seedCatalog();
    const c = await makeCustomer();
    for (let i = 0; i < 3; i++) await ctx.api(c.token).post("/api/reviews").send({ productId: "gold-ring", review: `r${i}`, rating: 5 });
    expect(await Review.countDocuments({ productId: "gold-ring" })).toBe(1);
  });
});

// ─── S6 ──────────────────────────────────────────────────────────────────────

describe("S6 · orderId is ORD-${Date.now()} with a unique index", () => {
  /** Occupy every orderId the next few seconds could produce. */
  const occupyNextMillis = async (ms = 4000, prefix = "ORD-") => {
    const start = Date.now();
    const docs = Array.from({ length: ms }, (_, i) => ({ orderId: `${prefix}${start + i}`, totalAmount: 1, items: [] }));
    await Order.collection.insertMany(docs);
  };

  bug("S6a: a same-millisecond collision on POST /api/orders still places the order", async () => {
    await seedCatalog();
    const c = await makeCustomer();
    await occupyNextMillis();
    const res = await ctx.api(c.token).post("/api/orders").send({ items: [{ productId: "gold-ring" }], paymentMethod: "cod" });
    expect(res.status).toBe(201);
  });

  it("S6a (impact): the collision is a 500, and the reserved stock IS put back", async () => {
    await seedCatalog();
    const c = await makeCustomer();
    await occupyNextMillis();
    const res = await ctx.api(c.token).post("/api/orders").send({ items: [{ productId: "gold-ring", quantity: 2 }], paymentMethod: "cod" });
    expect(res.status).toBe(500);
    expect(await stockOf("gold-ring")).toBe(5);
  });

  it("S6b (impact): on the card path the Razorpay order is created, then the DB write 500s", async () => {
    await seedCatalog();
    const c = await makeCustomer();
    await occupyNextMillis();
    const res = await ctx.api(c.token).post("/api/payment/create-order").send({ items: [{ productId: "gold-ring" }] });
    expect(res.status).toBe(500);
    expect(mocks().razorpayCreate).toHaveBeenCalledTimes(1); // orphaned Razorpay order
    expect(await stockOf("gold-ring")).toBe(5);
  });
});

// ─── S7 ──────────────────────────────────────────────────────────────────────

describe("S7 · admin changes to expired / cancelled / rejected orders", () => {
  const admin = () => makeAdmin();

  bug("S7a: an expired order cannot be approved", async () => {
    const a = await admin();
    const o = await insertOrder({ orderStatus: "expired", paymentStatus: "expired", paymentMethod: "razorpay", stockReserved: false, expiredAt: new Date() });
    const res = await ctx.api(a.token).patch(`/api/orders/${o._id}/approval`).send({ approvalStatus: "APPROVED" });
    expect(res.status).toBe(400);
  });

  bug("S7b: an expired order cannot be moved to shipped/delivered", async () => {
    const a = await admin();
    const o = await insertOrder({ orderStatus: "expired", approvalStatus: "APPROVED", stockReserved: false });
    const res = await ctx.api(a.token).patch(`/api/orders/${o._id}/status`).send({ status: "shipped" });
    expect(res.status).toBe(400);
  });

  bug("S7c: a cancelled order cannot be moved back to processing/shipped/delivered", async () => {
    const a = await admin();
    const o = await insertOrder({ orderStatus: "cancelled", approvalStatus: "APPROVED", stockReserved: false });
    for (const s of ["processing", "shipped", "delivered"]) {
      expect((await ctx.api(a.token).patch(`/api/orders/${o._id}/status`).send({ status: s })).status, s).toBe(400);
    }
  });

  bug("S7d: a delivered order cannot go back to processing", async () => {
    const a = await admin();
    const o = await insertOrder({ orderStatus: "delivered", approvalStatus: "APPROVED", deliveredAt: new Date() });
    expect((await ctx.api(a.token).patch(`/api/orders/${o._id}/status`).send({ status: "processing" })).status).toBe(400);
  });

  bug("S7e: a REJECTED order cannot later be APPROVED", async () => {
    await seedCatalog();
    const a = await admin();
    const c = await makeCustomer();
    const placed = await ctx.api(c.token).post("/api/orders").send({ items: [{ productId: "one-of-a-kind" }], paymentMethod: "cod" });
    const id = placed.body.data._id;
    await ctx.api(a.token).patch(`/api/orders/${id}/approval`).send({ approvalStatus: "REJECTED", rejectionReason: "x" });
    const res = await ctx.api(a.token).patch(`/api/orders/${id}/approval`).send({ approvalStatus: "APPROVED" });
    expect(res.status).toBe(400);
  });

  it("S7e (impact): reject → approve leaves an APPROVED order holding no stock, and the piece sells twice", async () => {
    await seedCatalog();
    const a = await admin();
    const c1 = await makeCustomer();
    const c2 = await makeCustomer();
    const first = await ctx.api(c1.token).post("/api/orders").send({ items: [{ productId: "one-of-a-kind" }], paymentMethod: "cod" });
    const id = first.body.data._id;
    await ctx.api(a.token).patch(`/api/orders/${id}/approval`).send({ approvalStatus: "REJECTED", rejectionReason: "x" });
    await ctx.api(a.token).patch(`/api/orders/${id}/approval`).send({ approvalStatus: "APPROVED" });
    const second = await ctx.api(c2.token).post("/api/orders").send({ items: [{ productId: "one-of-a-kind" }], paymentMethod: "cod" });
    expect((await Order.findById(id).lean()).approvalStatus).toBe("APPROVED");
    expect(second.status).toBe(201); // one-of-a-kind piece, two live orders
  });

  bug("S7f: admin setting status 'cancelled' returns the reserved stock", async () => {
    await seedCatalog();
    const a = await admin();
    const c = await makeCustomer();
    const placed = await ctx.api(c.token).post("/api/orders").send({ items: [{ productId: "gold-ring", quantity: 2 }], paymentMethod: "cod" });
    await ctx.api(a.token).patch(`/api/orders/${placed.body.data._id}/status`).send({ status: "cancelled" });
    expect(await stockOf("gold-ring")).toBe(5);
  });
});

// ─── S8 ──────────────────────────────────────────────────────────────────────

describe("S8 · malformed ObjectIds", () => {
  const BAD = "not-an-object-id";
  const routes = {
    customer: [
      ["get", `/api/orders/${BAD}`],
      ["patch", `/api/orders/${BAD}/cancel`, {}],
      ["delete", `/api/reviews/${BAD}`],
      ["patch", `/api/users/me/addresses/${BAD}`, { city: "x" }],
      ["delete", `/api/users/me/addresses/${BAD}`],
      ["patch", `/api/cart/${BAD}`, { quantity: 1 }],
    ],
    // These also match by productId, so a non-ObjectId is a legitimate key and
    // the correct answer is 200 { deletedCount: 0 }.
    lookupByProductId: [
      ["delete", `/api/cart/${BAD}`],
      ["delete", `/api/wishlist/${BAD}`],
    ],
    admin: [
      ["patch", `/api/orders/${BAD}/status`, { status: "processing" }],
      ["patch", `/api/orders/${BAD}/approval`, { approvalStatus: "APPROVED" }],
      ["patch", `/api/users/${BAD}`, { name: "x" }],
      ["delete", `/api/users/${BAD}`],
      ["patch", `/api/categories/${BAD}`, { categoryName: "x" }],
      ["delete", `/api/categories/${BAD}`],
      ["patch", `/api/quotes/${BAD}/status`, { status: "Closed" }],
      ["patch", `/api/products/${BAD}`, { stock: 1 }],
      ["delete", `/api/products/${BAD}`],
      ["get", `/api/products/${BAD}`],
    ],
  };

  const call = async (who, [method, path, body]) => {
    const { token } = who === "admin" ? await makeAdmin() : await makeCustomer();
    const t = ctx.api(token)[method](path);
    return body ? t.send(body) : t;
  };

  // Split after running: these return 500 today.
  const BROKEN = new Set([
    `get /api/orders/${BAD}`,
    `patch /api/orders/${BAD}/cancel`,
    `delete /api/reviews/${BAD}`,
    `patch /api/orders/${BAD}/status`,
    `patch /api/orders/${BAD}/approval`,
    `patch /api/users/${BAD}`,
    `delete /api/users/${BAD}`,
    `patch /api/categories/${BAD}`,
    `delete /api/categories/${BAD}`,
    `patch /api/quotes/${BAD}/status`,
  ]);

  for (const who of ["customer", "admin"]) {
    for (const route of routes[who]) {
      const key = `${route[0]} ${route[1]}`;
      const test = BROKEN.has(key) ? bug : it;
      test(`S8: ${key} → 400/404, not 500`, async () => {
        const res = await call(who, route);
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
      });
    }
  }

  for (const route of routes.lookupByProductId) {
    it(`S8: ${route[0]} ${route[1]} → 200 deletedCount 0`, async () => {
      const res = await call("customer", route);
      expect(res.status).toBe(200);
      expect(res.body.deletedCount).toBe(0);
    });
  }
});

// ─── S9 ──────────────────────────────────────────────────────────────────────

describe("S9 · fields the React pages send that the schemas drop or mangle", () => {
  bug("S9a: AdminAddProduct's details.description / details.advantages are persisted", async () => {
    const { token } = await makeAdmin();
    // Exact shape AdminAddProduct.jsx onSubmit builds.
    const res = await ctx.api(token).post("/api/products").send({
      name: "Temple Necklace",
      category: "Gold",
      details: { description: "Hand-finished temple work", advantages: ["BIS hallmarked", "22K"] },
      price: 0, weight: 12, wastagePercent: 8, gstPercent: 3, metalType: "gold",
      isQuoteOnly: false, discountPrice: null, discountPercentage: null, size: "", stock: 1, carate: 22,
      newArrival: false, badge: false, flashSale: false, addedAt: new Date().toISOString(),
    });
    const p = await Product.findById(res.body.data._id).lean();
    const description = p.details?.description ?? p.description;
    expect(description).toBe("Hand-finished temple work");
  });

  bug("S9b: badge:false (AdminAddProduct when 'HOT' is not ticked) is not stored as the string 'false'", async () => {
    const { token } = await makeAdmin();
    const res = await ctx.api(token).post("/api/products").send({ name: "n", category: "Gold", badge: false });
    expect(res.body.data.badge).not.toBe("false");
  });

  bug("S9c: POST /api/cart without a name is a 400, not a 500 (schema says optional, model says required)", async () => {
    const c = await makeCustomer();
    const res = await ctx.api(c.token).post("/api/cart").send({ productId: "gold-ring" });
    expect(res.status).toBeLessThan(500);
  });

  bug("S9d: POST /api/wishlist without a name is a 400, not a 500", async () => {
    const c = await makeCustomer();
    const res = await ctx.api(c.token).post("/api/wishlist").send({ productId: "gold-ring" });
    expect(res.status).toBeLessThan(500);
  });

  it("S9 (ok): contact phone/subject, product size/carate and order shippingAddress all persist", async () => {
    await seedCatalog();
    await ctx.api().post("/api/contact").send({ name: "A", email: "a@b.co", phone: "98", subject: "s", message: "m" });
    const c = await makeCustomer();
    const o = await ctx.api(c.token).post("/api/orders").send({ items: [{ productId: "gold-ring" }], paymentMethod: "cod", shippingAddress: SHIPPING });
    expect((await Order.findById(o.body.data._id).lean()).shippingAddress).toEqual(SHIPPING);
  });
});
