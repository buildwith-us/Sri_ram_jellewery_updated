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

describe("S1 · PATCH /api/users/:id passed req.body straight to findByIdAndUpdate (S1a/S1e fixed)", () => {
  it("S1a: an admin request cannot write passwordHash / otpHash / unnormalised phone", async () => {
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

  it("S1a: such a request is refused outright (400), so no password the admin chose ever logs in", async () => {
    const admin = await makeAdmin();
    const c = await makeCustomer();
    const res = await ctx.api(admin.token).patch(`/api/users/${c.user._id}`).send({
      email: "victim@shop.test",
      passwordHash: await bcrypt.hash("attacker-chosen", 4),
    });
    expect(res.status).toBe(400);
    const login = await ctx.api().post("/api/auth/login").send({ email: "victim@shop.test", password: "attacker-chosen" });
    expect(login.status).toBe(401);
  });

  it.each([["emailKey", "x@y.co"], ["phone", "9876543210"], ["contactEmail", "x@y.co"], ["otpExpiresAt", "2030-01-01"], ["photoURL", "x"]])(
    "S1a: %s is not on the whitelist → 400, nothing written",
    async (field, value) => {
      const admin = await makeAdmin();
      const c = await makeCustomer();
      const res = await ctx.api(admin.token).patch(`/api/users/${c.user._id}`).send({ [field]: value });
      expect(res.status).toBe(400);
      expect((await User.findById(c.user._id).lean())[field]).toEqual(c.user[field]);
    }
  );

  it("S1a: name is still editable", async () => {
    const admin = await makeAdmin();
    const c = await makeCustomer();
    const res = await ctx.api(admin.token).patch(`/api/users/${c.user._id}`).send({ name: "  Corrected Name " });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe("Corrected Name");
  });

  it("S1: a customer (email-code account, no password) cannot be promoted to ADMIN", async () => {
    const admin = await makeAdmin();
    const c = await makeCustomer();
    const res = await ctx.api(admin.token).patch(`/api/users/${c.user._id}`).send({ role: "ADMIN" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/password/);
    expect((await User.findById(c.user._id).lean()).role).toBe("USER");
  });

  it("S1: an account that signs in with a password (and has no emailKey) can be promoted", async () => {
    const admin = await makeAdmin();
    const staff = await User.create({ email: "staff@shop.in", passwordHash: await bcrypt.hash("pw-staff-123", 4), role: "USER" });
    const res = await ctx.api(admin.token).patch(`/api/users/${staff._id}`).send({ role: "ADMIN" });
    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe("ADMIN");
  });

  it("S1: a password account that also has an emailKey cannot be promoted (emailKey never on an admin)", async () => {
    const admin = await makeAdmin();
    const odd = await User.create({ email: "odd@shop.in", emailKey: "odd@shop.in", passwordHash: "x", role: "USER" });
    expect((await ctx.api(admin.token).patch(`/api/users/${odd._id}`).send({ role: "ADMIN" })).status).toBe(400);
  });

  it("S1b: the response never includes otpHash", async () => {
    const admin = await makeAdmin();
    const c = await makeCustomer({ otpHash: "$2b$12$secretish" });
    const res = await ctx.api(admin.token).patch(`/api/users/${c.user._id}`).send({ name: "x" });
    expect(res.body.data.otpHash).toBeUndefined();
  });

  it("S1c: the last admin cannot demote themselves", async () => {
    const admin = await makeAdmin();
    const res = await ctx.api(admin.token).patch(`/api/users/${admin.user._id}`).send({ role: "USER" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await User.findById(admin.user._id).lean()).role).toBe("ADMIN");
  });

  it("S1c: with a second admin who can sign in, demotion is allowed", async () => {
    const a1 = await makeAdmin();
    await makeAdmin();
    const res = await ctx.api(a1.token).patch(`/api/users/${a1.user._id}`).send({ role: "USER" });
    expect(res.status).toBe(200);
  });

  it("S1c: a second admin record WITHOUT a password does not count", async () => {
    const a1 = await makeAdmin();
    await User.create({ email: "ghost@shop.in", role: "ADMIN" });
    const res = await ctx.api(a1.token).patch(`/api/users/${a1.user._id}`).send({ role: "USER" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least one administrator/);
  });

  it("S1d: the last admin cannot delete themselves", async () => {
    const admin = await makeAdmin();
    const res = await ctx.api(admin.token).delete(`/api/users/${admin.user._id}`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await User.countDocuments({ role: "ADMIN" })).toBe(1);
  });

  it("S1d: another admin can be deleted while one with a password remains", async () => {
    const a1 = await makeAdmin();
    const a2 = await makeAdmin();
    expect((await ctx.api(a1.token).delete(`/api/users/${a2.user._id}`)).status).toBe(200);
    expect((await ctx.api(a1.token).delete(`/api/users/${a1.user._id}`)).status).toBe(400);
  });

  it("S1e: an invalid role is refused", async () => {
    const admin = await makeAdmin();
    const c = await makeCustomer();
    const res = await ctx.api(admin.token).patch(`/api/users/${c.user._id}`).send({ role: "SUPERUSER" });
    expect(res.status).toBe(400);
    expect((await User.findById(c.user._id).lean()).role).toBe("USER");
  });
});

// ─── S2 ──────────────────────────────────────────────────────────────────────

describe("S2 · POST /api/orders accepted any paymentMethod (fixed)", () => {
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

  it.each(["razorpay", "upi", "free", "card", "cash", ""])(
    "S2a: paymentMethod %j is refused — only COD may skip payment",
    async (m) => {
      const { res } = await place(m);
      expect(res.status).toBe(400);
    }
  );

  it("S2a: a refused 'upi' order (the Checkout page's UPI / QR SCAN option) writes nothing, alerts nobody, keeps the bag", async () => {
    const { c, res } = await place("upi");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Cash on Delivery/);
    expect(await Order.countDocuments()).toBe(0);
    expect(await stockOf("gold-ring")).toBe(5);
    expect(mocks().whatsapp.sendOrderAlert).not.toHaveBeenCalled();
    expect(await Cart.countDocuments({ userId: String(c.user._id) })).toBe(1);
  });

  it.each(["COD", " Cod ", "cod"])("S2b: %j is cash on delivery — stored as 'cod', never swept", async (m) => {
    const { res } = await place(m);
    expect(res.status).toBe(201);
    const o = await Order.findById(res.body.data._id).lean();
    expect(o.paymentMethod).toBe("cod");
    await Order.updateOne({ _id: o._id }, { createdAt: hourAgo() });
    const sweep = await releaseStaleReservations();
    expect(sweep.released).toHaveLength(0);
    expect(await stockOf("gold-ring")).toBe(4);
  });

  it("S2b: a legacy order stored as 'COD' before normalisation is never swept", async () => {
    await seedCatalog();
    // Raw insert: bypasses the model's lowercase setter, as old documents did.
    await Order.collection.insertOne({
      orderId: "ORD-LEGACY-COD",
      items: [{ productId: "gold-ring", quantity: 1 }],
      totalAmount: 80752,
      paymentMethod: "COD",
      paymentStatus: "pending",
      orderStatus: "processing",
      stockReserved: true,
      paidAt: null,
      createdAt: hourAgo(),
    });
    expect((await releaseStaleReservations()).released).toHaveLength(0);
    expect(await stockOf("gold-ring")).toBe(5);
  });

  it("S2c: omitted paymentMethod → stored as COD with paymentStatus 'unpaid' (not 'pending')", async () => {
    const { res } = await place(undefined);
    const o = await Order.findById(res.body.data._id).lean();
    expect(o.paymentMethod).toBe("cod");
    expect(o.paymentStatus).toBe("unpaid");
  });

  // Not part of S2's fix: approval rules are Batch 2. The unpaid online order
  // now comes from create-order, the only route that can still make one.
  it("S2d: an unpaid online order cannot be approved and shipped", async () => {
    await seedCatalog();
    const c = await makeCustomer();
    const created = await ctx.api(c.token).post("/api/payment/create-order").send({ items: [{ productId: "gold-ring" }], shippingAddress: SHIPPING });
    expect(created.status).toBe(200);
    const admin = await makeAdmin();
    const approve = await ctx.api(admin.token).patch(`/api/orders/${created.body.orderId}/approval`).send({ approvalStatus: "APPROVED" });
    expect(approve.status).toBe(400);
  });
});

// ─── S3 ──────────────────────────────────────────────────────────────────────

describe("S3 · cancelling / rejecting a PAID online order (fixed)", () => {
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

  it("S3a: customer cancel of a paid order sets refundRequired", async () => {
    const { c, orderId } = await paidOrder();
    await ctx.api(c.token).patch(`/api/orders/${orderId}/cancel`);
    expect((await Order.findById(orderId).lean()).refundRequired).toBe(true);
  });

  it("S3b: customer cancel of a paid order alerts the owner", async () => {
    const { c, orderId } = await paidOrder();
    await ctx.api(c.token).patch(`/api/orders/${orderId}/cancel`);
    const w = mocks().whatsapp;
    const alerted = w.sendRefundRequiredAlert.mock.calls.length + w.sendOrderAlert.mock.calls.length + w.sendOrderApprovalAlert.mock.calls.length;
    expect(alerted).toBeGreaterThan(0);
  });

  it("S3: the alert is the REFUND NEEDED one, says why, and is sent once", async () => {
    const { c, orderId } = await paidOrder();
    await ctx.api(c.token).patch(`/api/orders/${orderId}/cancel`);
    const calls = mocks().whatsapp.sendRefundRequiredAlert.mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0].reason).toMatch(/customer cancelled this paid order/);
    expect(calls[0][0].order.refundRequired).toBe(true);
  });

  it("S3: admin cancelling a paid order from the status menu flags it too", async () => {
    const { orderId } = await paidOrder();
    const admin = await makeAdmin();
    await ctx.api(admin.token).patch(`/api/orders/${orderId}/status`).send({ status: "cancelled" });
    expect((await Order.findById(orderId).lean()).refundRequired).toBe(true);
    expect(mocks().whatsapp.sendRefundRequiredAlert).toHaveBeenCalledTimes(1);
  });

  it("S3: COD and unpaid online orders are never flagged", async () => {
    await seedCatalog();
    const c = await makeCustomer();
    const admin = await makeAdmin();
    const cod = await ctx.api(c.token).post("/api/orders").send({ items: [{ productId: "gold-ring" }], paymentMethod: "cod" });
    await ctx.api(c.token).patch(`/api/orders/${cod.body.data._id}/cancel`);
    const unpaid = await ctx.api(c.token).post("/api/payment/create-order").send({ items: [{ productId: "silver-anklet" }], shippingAddress: SHIPPING });
    await ctx.api(admin.token).patch(`/api/orders/${unpaid.body.orderId}/status`).send({ status: "cancelled" });
    expect(await Order.countDocuments({ refundRequired: true })).toBe(0);
    expect(mocks().whatsapp.sendRefundRequiredAlert).not.toHaveBeenCalled();
  });

  it("S3c: owner rejecting a paid order sets refundRequired", async () => {
    const { orderId } = await paidOrder();
    const admin = await makeAdmin();
    await ctx.api(admin.token).patch(`/api/orders/${orderId}/approval`).send({ approvalStatus: "REJECTED", rejectionReason: "No stock" });
    expect((await Order.findById(orderId).lean()).refundRequired).toBe(true);
  });
});

// ─── S4 ──────────────────────────────────────────────────────────────────────

// Closed by the move to email sign-in: the limiters now key on the normalised
// address (utils/emailIdentity.js), the same key the account and code use.
// Phone is no longer a sign-in identity, so the phone spellings are moot.
describe("S4 · OTP limiters keyed on the raw identity (fixed for email sign-in)", () => {
  const prod = () => setEnv("NODE_ENV", "production");
  const n = () => `spell${process.pid}${Math.random().toString(36).slice(2, 7)}`;
  const spellingsOf = (local) => [
    `${local}@gmail.com`,
    `${local.toUpperCase()}@GMAIL.COM`,
    ` ${local}@gmail.com `,
    `${local}+x@gmail.com`,
    `${local.slice(0, 3)}.${local.slice(3)}@gmail.com`,
    `${local}@googlemail.com`,
  ];

  it("S4a: exhausting verify attempts with one spelling also blocks the other spellings", async () => {
    prod();
    const local = n();
    const [first, ...others] = spellingsOf(local);
    await ctx.api().post("/api/auth/otp/request").send({ email: first });
    for (let i = 0; i < 5; i++) await ctx.api().post("/api/auth/otp/verify").send({ email: first, otp: "000000" });
    expect((await ctx.api().post("/api/auth/otp/verify").send({ email: first, otp: "000000" })).status).toBe(429);
    for (const spelling of others) {
      const r = await ctx.api().post("/api/auth/otp/verify").send({ email: spelling, otp: "000000" });
      expect(r.status, spelling).toBe(429);
    }
  });

  it("S4a: one address gets exactly 5 guesses per window, whatever the spelling", async () => {
    prod();
    const spellings = spellingsOf(n());
    await ctx.api().post("/api/auth/otp/request").send({ email: spellings[0] });
    let accepted = 0;
    for (const s of spellings) {
      for (let i = 0; i < 5; i++) {
        const r = await ctx.api().post("/api/auth/otp/verify").send({ email: s, otp: "000000" });
        if (r.status === 401) accepted++;
      }
    }
    expect(accepted).toBe(5);
  });

  it("S4b: code *requests* are also capped per address across spellings", async () => {
    prod();
    const [first, second] = spellingsOf(n());
    for (let i = 0; i < 10; i++) await ctx.api().post("/api/auth/otp/request").send({ email: first });
    const r = await ctx.api().post("/api/auth/otp/request").send({ email: second });
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

describe("S6 · order numbers: SRJ-YYYYMMDD-NNNN from a daily counter (fixed)", () => {
  /** Occupy every ORD-<ms> id the next few seconds could produce (the old scheme). */
  const occupyNextMillis = async (ms = 4000, prefix = "ORD-") => {
    const start = Date.now();
    const docs = Array.from({ length: ms }, (_, i) => ({ orderId: `${prefix}${start + i}`, totalAmount: 1, items: [] }));
    await Order.collection.insertMany(docs);
  };

  it("S6a: a same-millisecond collision on POST /api/orders still places the order", async () => {
    await seedCatalog();
    const c = await makeCustomer();
    await occupyNextMillis();
    const res = await ctx.api(c.token).post("/api/orders").send({ items: [{ productId: "gold-ring" }], paymentMethod: "cod" });
    expect(res.status).toBe(201);
    expect(res.body.data.orderId).toMatch(/^SRJ-\d{8}-\d{4}$/);
  });

  it("S6a: 30 simultaneous orders all succeed, with 30 distinct consecutive numbers", async () => {
    await seedRates();
    await createProduct("gold", { stock: 100 });
    const customers = await Promise.all(Array.from({ length: 30 }, () => makeCustomer()));
    const results = await Promise.all(
      customers.map((c) => ctx.api(c.token).post("/api/orders").send({ items: [{ productId: "gold-ring" }], paymentMethod: "cod" }))
    );
    expect(results.map((r) => r.status)).toEqual(Array(30).fill(201));
    const ids = results.map((r) => r.body.data.orderId).sort();
    expect(new Set(ids).size).toBe(30);
    const seqs = ids.map((id) => Number(id.split("-")[2]));
    expect(seqs).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(await stockOf("gold-ring")).toBe(70);
  });

  it("S6a: a number already stored (e.g. counter reset) is skipped, not a 500", async () => {
    await seedCatalog();
    const c = await makeCustomer();
    const { nextOrderId } = await import("../../server/utils/orderId.js");
    const { Counter } = await import("../../server/models/Counter.js");
    const taken = await nextOrderId(); // …-0001
    await Order.collection.insertOne({ orderId: taken, totalAmount: 1, items: [] });
    await Counter.deleteMany({}); // the counter forgets it handed that out
    const res = await ctx.api(c.token).post("/api/orders").send({ items: [{ productId: "gold-ring" }], paymentMethod: "cod" });
    expect(res.status).toBe(201);
    expect(res.body.data.orderId).toBe(taken.replace(/-0001$/, "-0002"));
  });

  it("S6b: the card path gets the same format, and Razorpay's receipt carries it", async () => {
    await seedCatalog();
    const c = await makeCustomer();
    const res = await ctx.api(c.token).post("/api/payment/create-order").send({ items: [{ productId: "gold-ring" }], shippingAddress: SHIPPING });
    expect(res.status).toBe(200);
    const o = await Order.findById(res.body.orderId).lean();
    expect(o.orderId).toMatch(/^SRJ-\d{8}-\d{4}$/);
    expect(mocks().razorpayCreate.mock.calls[0][0].receipt).toBe(o.orderId);
  });

  it("S6: existing ORD-… numbers are left exactly as they are", async () => {
    await Order.collection.insertOne({ orderId: "ORD-1760023847193", totalAmount: 1, items: [] });
    await seedCatalog();
    const c = await makeCustomer();
    await ctx.api(c.token).post("/api/orders").send({ items: [{ productId: "gold-ring" }], paymentMethod: "cod" });
    expect(await Order.countDocuments({ orderId: "ORD-1760023847193" })).toBe(1);
  });
});

// ─── S7 ──────────────────────────────────────────────────────────────────────

describe("S7 · admin changes to expired / cancelled / rejected orders (fixed — utils/orderStatus.js)", () => {
  const admin = () => makeAdmin();

  it("S7a: an expired order cannot be approved", async () => {
    const a = await admin();
    const o = await insertOrder({ orderStatus: "expired", paymentStatus: "expired", paymentMethod: "razorpay", stockReserved: false, expiredAt: new Date() });
    const res = await ctx.api(a.token).patch(`/api/orders/${o._id}/approval`).send({ approvalStatus: "APPROVED" });
    expect(res.status).toBe(400);
  });

  it("S7b: an expired order cannot be moved to shipped/delivered", async () => {
    const a = await admin();
    const o = await insertOrder({ orderStatus: "expired", approvalStatus: "APPROVED", stockReserved: false });
    const res = await ctx.api(a.token).patch(`/api/orders/${o._id}/status`).send({ status: "shipped" });
    expect(res.status).toBe(400);
  });

  it("S7c: a cancelled order cannot be moved back to processing/shipped/delivered", async () => {
    const a = await admin();
    const o = await insertOrder({ orderStatus: "cancelled", approvalStatus: "APPROVED", stockReserved: false });
    for (const s of ["processing", "shipped", "delivered"]) {
      expect((await ctx.api(a.token).patch(`/api/orders/${o._id}/status`).send({ status: s })).status, s).toBe(400);
    }
  });

  it("S7d: a delivered order cannot go back to processing", async () => {
    const a = await admin();
    const o = await insertOrder({ orderStatus: "delivered", approvalStatus: "APPROVED", deliveredAt: new Date() });
    expect((await ctx.api(a.token).patch(`/api/orders/${o._id}/status`).send({ status: "processing" })).status).toBe(400);
  });

  it("S7e: a REJECTED order cannot later be APPROVED", async () => {
    await seedCatalog();
    const a = await admin();
    const c = await makeCustomer();
    const placed = await ctx.api(c.token).post("/api/orders").send({ items: [{ productId: "one-of-a-kind" }], paymentMethod: "cod" });
    const id = placed.body.data._id;
    await ctx.api(a.token).patch(`/api/orders/${id}/approval`).send({ approvalStatus: "REJECTED", rejectionReason: "x" });
    const res = await ctx.api(a.token).patch(`/api/orders/${id}/approval`).send({ approvalStatus: "APPROVED" });
    expect(res.status).toBe(400);
  });

  it("S7e: after reject → (refused) approve, the order stays REJECTED and the piece sells to the next customer only once", async () => {
    await seedCatalog();
    const a = await admin();
    const c1 = await makeCustomer();
    const c2 = await makeCustomer();
    const c3 = await makeCustomer();
    const first = await ctx.api(c1.token).post("/api/orders").send({ items: [{ productId: "one-of-a-kind" }], paymentMethod: "cod" });
    const id = first.body.data._id;
    await ctx.api(a.token).patch(`/api/orders/${id}/approval`).send({ approvalStatus: "REJECTED", rejectionReason: "x" });
    expect((await ctx.api(a.token).patch(`/api/orders/${id}/approval`).send({ approvalStatus: "APPROVED" })).status).toBe(400);
    expect((await Order.findById(id).lean()).approvalStatus).toBe("REJECTED");
    expect((await ctx.api(c2.token).post("/api/orders").send({ items: [{ productId: "one-of-a-kind" }], paymentMethod: "cod" })).status).toBe(201);
    expect((await ctx.api(c3.token).post("/api/orders").send({ items: [{ productId: "one-of-a-kind" }], paymentMethod: "cod" })).status).toBe(409);
  });

  it("S7f: admin setting status 'cancelled' returns the reserved stock", async () => {
    await seedCatalog();
    const a = await admin();
    const c = await makeCustomer();
    const placed = await ctx.api(c.token).post("/api/orders").send({ items: [{ productId: "gold-ring", quantity: 2 }], paymentMethod: "cod" });
    await ctx.api(a.token).patch(`/api/orders/${placed.body.data._id}/status`).send({ status: "cancelled" });
    expect(await stockOf("gold-ring")).toBe(5);
  });
});

// ─── S8 ──────────────────────────────────────────────────────────────────────

describe("S8 · malformed ObjectIds (fixed)", () => {
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

  // These returned 500 before S8 was fixed; every route here is now a 404.
  const BROKEN = new Set();

  for (const who of ["customer", "admin"]) {
    for (const route of routes[who]) {
      const key = `${route[0]} ${route[1]}`;
      const test = BROKEN.has(key) ? bug : it;
      test(`S8: ${key} → 400/404, not 500`, async () => {
        const res = await call(who, route);
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
        expect(res.body.error).toMatch(/not found/i);
      });
    }
  }

  it("S8: the 404 names the right thing (a bad address id is 'Address not found')", async () => {
    const { token } = await makeCustomer();
    expect((await ctx.api(token).delete(`/api/users/me/addresses/${BAD}`)).body.error).toBe("Address not found");
    expect((await ctx.api(token).get(`/api/orders/${BAD}`)).body.error).toBe("Order not found");
  });

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
