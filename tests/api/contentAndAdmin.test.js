import { describe, it, expect } from "vitest";
import { useApp, mocks } from "../helpers/app.js";
import { makeCustomer, makeAdmin, insertOrder, seedCatalog, daysAgo } from "../helpers/factories.js";
import { Review } from "../../server/models/Review.js";
import { QuoteRequest } from "../../server/models/QuoteRequest.js";
import { ContactMessage } from "../../server/models/ContactMessage.js";
import { NewsletterSubscriber } from "../../server/models/NewsletterSubscriber.js";
import { ProductView } from "../../server/models/ProductView.js";
import { Wishlist } from "../../server/models/Wishlist.js";

const ctx = useApp();

// ─── Reviews ─────────────────────────────────────────────────────────────────

describe("reviews", () => {
  it("create → 201 with the caller's userId; GET by product and GET all", async () => {
    const c = await makeCustomer();
    const res = await ctx.api(c.token).post("/api/reviews").send({ productId: "gold-ring", productName: "Gold Ring", review: "Lovely", rating: "5", name: "Asha" });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ rating: 5, userId: String(c.user._id), name: "Asha" });
    expect((await ctx.api().get("/api/reviews/gold-ring")).body.data).toHaveLength(1);
    expect((await ctx.api().get("/api/reviews/other")).body.data).toHaveLength(0);
    expect(await ctx.api().get("/api/reviews").then((r) => r.body)).toHaveLength(1);
  });

  it("site testimonial without productId; name defaults to Anonymous", async () => {
    const c = await makeCustomer();
    const res = await ctx.api(c.token).post("/api/reviews").send({ review: "Great shop", rating: 4 });
    expect(res.body.data.name).toBe("Anonymous");
  });

  it.each([
    [{ rating: 5 }, /Review text is required/],
    [{ review: "x", rating: 0 }, /between 1 and 5/],
    [{ review: "x", rating: 6 }, /between 1 and 5/],
    [{ review: "x" }, /between 1 and 5/],
  ])("validation %j → 400", async (body, msg) => {
    const c = await makeCustomer();
    const res = await ctx.api(c.token).post("/api/reviews").send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(msg);
  });

  it("delete: owner 200, other customer 403, admin 200, unknown 404", async () => {
    const owner = await makeCustomer();
    const other = await makeCustomer();
    const admin = await makeAdmin();
    const r1 = (await ctx.api(owner.token).post("/api/reviews").send({ review: "a", rating: 5 })).body.data;
    const r2 = (await ctx.api(owner.token).post("/api/reviews").send({ review: "b", rating: 5 })).body.data;
    expect((await ctx.api(other.token).delete(`/api/reviews/${r1._id}`)).status).toBe(403);
    expect((await ctx.api(owner.token).delete(`/api/reviews/${r1._id}`)).status).toBe(200);
    expect((await ctx.api(admin.token).delete(`/api/reviews/${r2._id}`)).status).toBe(200);
    expect((await ctx.api(admin.token).delete(`/api/reviews/${r2._id}`)).status).toBe(404);
  });

  it("empty DB → [] not 500", async () => {
    expect((await ctx.api().get("/api/reviews")).body).toEqual([]);
    expect((await ctx.api().get("/api/reviews/x")).body).toEqual({ success: true, data: [] });
  });
});

// ─── Quotes ──────────────────────────────────────────────────────────────────

describe("quotes", () => {
  const body = { productId: "diamond-set", productName: "Diamond Set", customerName: "Asha", customerMobile: "9876543210", isQuoteOnly: true };

  it("customer submits → 201, owner alerted; admin lists and updates status", async () => {
    const c = await makeCustomer();
    const admin = await makeAdmin();
    const res = await ctx.api(c.token).post("/api/quotes").send(body);
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe("Pending");
    expect(mocks().whatsapp.sendWhatsAppAlert).toHaveBeenCalledWith(expect.objectContaining({ customerName: "Asha", isQuoteOnly: true }));
    const list = await ctx.api(admin.token).get("/api/quotes");
    expect(list.body.data).toHaveLength(1);
    const upd = await ctx.api(admin.token).patch(`/api/quotes/${res.body.data._id}/status`).send({ status: "Contacted" });
    expect(upd.body.data.status).toBe("Contacted");
  });

  it("alert failure does not fail the request", async () => {
    mocks().whatsapp.sendWhatsAppAlert.mockRejectedValueOnce(new Error("down"));
    const c = await makeCustomer();
    expect((await ctx.api(c.token).post("/api/quotes").send(body)).status).toBe(201);
  });

  it.each([
    [{ ...body, productId: undefined }, /Product ID/],
    [{ ...body, customerName: "" }, /Customer name/],
    [{ ...body, customerMobile: "123" }, /mobile/],
  ])("validation → 400", async (b, msg) => {
    const c = await makeCustomer();
    const res = await ctx.api(c.token).post("/api/quotes").send(b);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(msg);
  });

  it("status update: invalid value → 400, unknown id → 404", async () => {
    const admin = await makeAdmin();
    const q = await QuoteRequest.create({ productId: "p", customerName: "a", customerMobile: "9876543210" });
    expect((await ctx.api(admin.token).patch(`/api/quotes/${q._id}/status`).send({ status: "Won" })).status).toBe(400);
    expect((await ctx.api(admin.token).patch(`/api/quotes/0123456789abcdef01234567/status`).send({ status: "Closed" })).status).toBe(404);
  });

  it("empty DB → empty list", async () => {
    const admin = await makeAdmin();
    expect((await ctx.api(admin.token).get("/api/quotes")).body).toEqual({ success: true, data: [] });
  });
});

// ─── Contact & newsletter ────────────────────────────────────────────────────

describe("contact", () => {
  it("public submit keeps phone and subject (previously dropped by strict mode)", async () => {
    const res = await ctx.api().post("/api/contact").send({ name: "Asha", email: "a@b.co", phone: "9876543210", subject: "Sizing", message: "Hi" });
    expect(res.status).toBe(201);
    const saved = await ContactMessage.findOne().lean();
    expect(saved).toMatchObject({ phone: "9876543210", subject: "Sizing" });
  });

  it("About page payload (no phone/subject) works too", async () => {
    expect((await ctx.api().post("/api/contact").send({ name: "A", email: "a@b.co", message: "m" })).status).toBe(201);
  });

  it.each([
    [{ email: "a@b.co", message: "m" }, /Name/],
    [{ name: "A", email: "bad", message: "m" }, /email/],
    [{ name: "A", email: "a@b.co" }, /Message/],
    [{ name: "A", email: "a@b.co", message: "m", phone: "1".repeat(21) }, /./],
  ])("validation → 400", async (b, msg) => {
    const res = await ctx.api().post("/api/contact").send(b);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(msg);
  });

  it("admin list, newest first; empty → []", async () => {
    const admin = await makeAdmin();
    expect((await ctx.api(admin.token).get("/api/contact")).body.data).toEqual([]);
    await ContactMessage.create({ name: "old", email: "a@b.co", message: "m", createdAt: daysAgo(1) });
    await ContactMessage.create({ name: "new", email: "a@b.co", message: "m" });
    expect((await ctx.api(admin.token).get("/api/contact")).body.data.map((m) => m.name)).toEqual(["new", "old"]);
  });
});

describe("newsletter", () => {
  it("subscribe → 201; again (any case) → 200 already subscribed", async () => {
    expect((await ctx.api().post("/api/newsletter").send({ email: "Asha@Example.com" })).status).toBe(201);
    const again = await ctx.api().post("/api/newsletter").send({ email: "asha@example.COM" });
    expect(again.status).toBe(200);
    expect(again.body.message).toMatch(/already/);
    expect(await NewsletterSubscriber.countDocuments()).toBe(1);
  });

  it("invalid email → 400", async () => {
    expect((await ctx.api().post("/api/newsletter").send({ email: "nope" })).status).toBe(400);
  });

  it("admin list; empty → []", async () => {
    const admin = await makeAdmin();
    expect((await ctx.api(admin.token).get("/api/newsletter")).body).toEqual({ success: true, data: [] });
  });
});

// ─── Admin utilities ─────────────────────────────────────────────────────────

describe("admin routes", () => {
  it("total-spent groups by userId (OTP customers have no email)", async () => {
    const admin = await makeAdmin();
    await insertOrder({ userId: "u1", totalAmount: 100 });
    await insertOrder({ userId: "u1", totalAmount: 50 });
    await insertOrder({ userId: "u2", totalAmount: 70 });
    const res = await ctx.api(admin.token).get("/api/admin/total-spent");
    expect(res.body).toEqual([
      { userId: "u1", totalSpent: 150, orderCount: 2, email: null },
      { userId: "u2", totalSpent: 70, orderCount: 1, email: null },
    ]);
  });

  it("cloudinary signature: signed server-side, secret never returned", async () => {
    const admin = await makeAdmin();
    const res = await ctx.api(admin.token).get("/api/admin/cloudinary-signature");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ apiKey: "123456789012345", cloudName: "testcloud" });
    expect(res.body.signature).toMatch(/^[0-9a-f]{40}$/);
    expect(JSON.stringify(res.body)).not.toContain("test_cloudinary_secret");
  });

  it("cloudinary signature without CLOUDINARY_URL → 503", async () => {
    const admin = await makeAdmin();
    const saved = process.env.CLOUDINARY_URL;
    delete process.env.CLOUDINARY_URL;
    try {
      expect((await ctx.api(admin.token).get("/api/admin/cloudinary-signature")).status).toBe(503);
    } finally {
      process.env.CLOUDINARY_URL = saved;
    }
  });
});

describe("admin dashboard", () => {
  const ENDPOINTS = [
    "revenue",
    "revenue?period=weekly",
    "revenue?period=monthly",
    "sales-by-category",
    "best-selling",
    "most-wishlisted",
    "stats",
    "top-selling-categories",
    "income-stats",
    "popular-products",
    "recent-reviews",
    "most-viewed",
    "most-viewed?days=abc&limit=-5",
  ];

  it.each(ENDPOINTS)("%s on an empty DB → 200, empty shape", async (ep) => {
    const admin = await makeAdmin();
    const res = await ctx.api(admin.token).get(`/api/admin-dashboard/${ep}`);
    expect(res.status).toBe(200);
    const payload = res.body.data ?? res.body;
    if (ep === "stats") expect(res.body).toEqual({ totalOrders: 0, totalRevenue: 0, totalProducts: 0, totalCategories: 0 });
    else if (ep === "top-selling-categories") expect(res.body).toEqual({ totalCategories: 0, topCategories: [] });
    else expect(payload).toEqual([]);
  });

  it("with data: revenue, category sales, best sellers, stats", async () => {
    const admin = await makeAdmin();
    await seedCatalog();
    const line = (productId, category, unitPrice, quantity) => ({ productId, name: productId, category, unitPrice, quantity });
    await insertOrder({ paymentStatus: "paid", paymentMethod: "razorpay", totalAmount: 1000, items: [line("a", "Gold", 500, 2)] });
    await insertOrder({ paymentStatus: "paid", paymentMethod: "razorpay", totalAmount: 300, items: [line("b", "Silver", 300, 1)] });
    await insertOrder({ orderStatus: "cancelled", totalAmount: 9999, items: [line("a", "Gold", 9999, 1)] });

    const rev = (await ctx.api(admin.token).get("/api/admin-dashboard/revenue")).body.data;
    expect(rev).toHaveLength(1);
    expect(rev[0].totalRevenue).toBe(1300);

    const cat = (await ctx.api(admin.token).get("/api/admin-dashboard/sales-by-category")).body.data;
    expect(cat).toEqual([
      { category: "Gold", totalRevenue: 1000, totalOrders: 1, totalUnits: 2 },
      { category: "Silver", totalRevenue: 300, totalOrders: 1, totalUnits: 1 },
    ]);

    const best = (await ctx.api(admin.token).get("/api/admin-dashboard/best-selling")).body.data;
    expect(best[0]).toMatchObject({ productId: "a", totalUnitsSold: 2 });

    const stats = (await ctx.api(admin.token).get("/api/admin-dashboard/stats")).body;
    expect(stats).toMatchObject({ totalOrders: 3, totalRevenue: 1300, totalProducts: 5 });
  });

  it("most-wishlisted and most-viewed aggregate correctly", async () => {
    const admin = await makeAdmin();
    await Wishlist.create([
      { productId: "a", userId: "u1", name: "A" },
      { productId: "a", userId: "u2", name: "A" },
      { productId: "b", userId: "u1", name: "B" },
    ]);
    await ProductView.create([
      { productId: "a", sessionId: "s1", userId: "u1" },
      { productId: "a", sessionId: "s2" },
      { productId: "b", sessionId: "s1" },
      { productId: "c", sessionId: "s9", viewedAt: daysAgo(40) },
    ]);
    const wl = (await ctx.api(admin.token).get("/api/admin-dashboard/most-wishlisted")).body.data;
    expect(wl[0]).toMatchObject({ productId: "a", wishlistCount: 2 });
    const mv = await ctx.api(admin.token).get("/api/admin-dashboard/most-viewed?days=30");
    expect(mv.body.periodDays).toBe(30);
    expect(mv.body.data[0]).toMatchObject({ productId: "a", viewCount: 2, uniqueVisitors: 2, signedInViews: 1 });
    expect(mv.body.data.map((d) => d.productId)).not.toContain("c");
  });

  it("recent-reviews is capped at 5", async () => {
    const admin = await makeAdmin();
    await Review.create(Array.from({ length: 7 }, (_, i) => ({ name: `n${i}`, review: "r", rating: 5 })));
    expect((await ctx.api(admin.token).get("/api/admin-dashboard/recent-reviews")).body).toHaveLength(5);
  });
});
