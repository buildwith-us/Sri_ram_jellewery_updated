/** Rates, products (reads, filters, view tracking, admin CRUD) and categories. */
import { describe, it, expect } from "vitest";
import { useApp } from "../helpers/app.js";
import { seedCatalog, seedRates, createProduct, makeAdmin, makeCustomer, daysAgo } from "../helpers/factories.js";
import { GoldRate } from "../../server/models/GoldRate.js";
import { Product } from "../../server/models/Product.js";
import { ProductView } from "../../server/models/ProductView.js";
import { Category } from "../../server/models/Category.js";

const ctx = useApp();

// ─── Rates ───────────────────────────────────────────────────────────────────

describe("GET /api/rates", () => {
  it("empty DB → zeros, stale, and the bounds", async () => {
    const res = await ctx.api().get("/api/rates");
    expect(res.status).toBe(200);
    expect(res.body.gold).toMatchObject({ ratePerGram: 0, updatedAt: null, isStale: true, ageInDays: null });
    expect(res.body.bounds.gold).toEqual({ min: 2000, max: 50000 });
    expect(res.body.staleAfterDays).toBe(3);
  });

  it("reports each metal's own timestamp and staleness", async () => {
    await seedRates({ goldUpdatedAt: new Date(), silverUpdatedAt: daysAgo(5) });
    const res = await ctx.api().get("/api/rates");
    expect(res.body.gold).toMatchObject({ ratePerGram: 7000, isStale: false, ageInDays: 0 });
    expect(res.body.silver).toMatchObject({ ratePerGram: 90, isStale: true, ageInDays: 5 });
  });
});

describe("PATCH /api/rates", () => {
  const patch = async (body) => ctx.api((await makeAdmin()).token).patch("/api/rates").send(body);

  it.each([
    [{ gold: 1999 }, 400],
    [{ gold: 2000 }, 200],
    [{ gold: 50000 }, 200],
    [{ gold: 50001 }, 400],
    [{ silver: 19 }, 400],
    [{ silver: 20 }, 200],
    [{ silver: 5000 }, 200],
    [{ silver: 5001 }, 400],
    [{ gold: 96 }, 400],
    [{}, 400],
    [{ gold: "abc" }, 400],
  ])("%j → %i", async (body, status) => {
    expect((await patch(body)).status).toBe(status);
  });

  it("upserts, stamps updatedAt, and leaves the other metal alone", async () => {
    await seedRates({ silverUpdatedAt: daysAgo(10) });
    const before = await GoldRate.findOne({ metalType: "silver" }).lean();
    const res = await patch({ gold: "7250" });
    expect(res.status).toBe(200);
    const gold = await GoldRate.findOne({ metalType: "gold" }).lean();
    expect(gold.ratePerGram).toBe(7250);
    expect(Date.now() - gold.updatedAt.getTime()).toBeLessThan(5000);
    expect((await GoldRate.findOne({ metalType: "silver" }).lean()).updatedAt).toEqual(before.updatedAt);
    expect(await GoldRate.countDocuments()).toBe(2);
  });

  it("creates the rate document when none exists", async () => {
    await patch({ silver: 95 });
    expect((await GoldRate.findOne({ metalType: "silver" }).lean()).ratePerGram).toBe(95);
  });

  it("a rejected value leaves the stored rate unchanged", async () => {
    await seedRates();
    await patch({ gold: 96 });
    expect((await GoldRate.findOne({ metalType: "gold" }).lean()).ratePerGram).toBe(7000);
  });

  it("refreshing a stale rate re-opens checkout for that metal", async () => {
    await seedCatalog({ goldUpdatedAt: daysAgo(5) });
    const c = await makeCustomer();
    const order = () => ctx.api(c.token).post("/api/orders").send({ items: [{ productId: "gold-ring" }], paymentMethod: "cod" });
    expect((await order()).status).toBe(503);
    await patch({ gold: 7000 });
    expect((await order()).status).toBe(201);
  });
});

// ─── Products: reads ─────────────────────────────────────────────────────────

describe("product reads inject the live price", () => {
  it("GET /api/products → every product with a computed price and breakdown", async () => {
    await seedCatalog();
    const res = await ctx.api().get("/api/products");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, totalPages: 1, currentPage: 1 });
    const by = Object.fromEntries(res.body.data.map((p) => [p.productId, p]));
    expect(by["gold-ring"].price).toBe(80752);
    expect(by["gold-ring"].priceBreakdown).toEqual({ metalValue: 70000, wastageValue: 8400, gst: 2352, ratePerGram: 7000 });
    expect(by["silver-anklet"].price).toBe(5099);
    expect(by["gift-box"].price).toBe(1500);
    expect(by["diamond-set"].priceBreakdown).toBeUndefined();
  });

  it("GET /api/products?category= is case-insensitive; sort works", async () => {
    await seedCatalog();
    const gold = await ctx.api().get("/api/products?category=gold&sort=low-to-high");
    expect(gold.body.data.map((p) => p.productId)).toEqual(["one-of-a-kind", "gold-ring"]);
    const desc = await ctx.api().get("/api/products?sort=high-to-low");
    expect(desc.body.data[0].productId).toBe("gold-ring");
  });

  it("pagination: `page` is echoed but ignored — every product is returned (see report)", async () => {
    await seedCatalog();
    const p1 = await ctx.api().get("/api/products?page=1");
    const p2 = await ctx.api().get("/api/products?page=2");
    expect(p2.body.currentPage).toBe(2);
    expect(p2.body.data).toHaveLength(p1.body.data.length);
  });

  it("GET /api/products/:id by Mongo _id and by productId", async () => {
    const cat = await seedCatalog();
    const a = await ctx.api().get(`/api/products/${cat.gold._id}`);
    const b = await ctx.api().get("/api/products/gold-ring");
    expect(a.status).toBe(200);
    expect(a.body.data.price).toBe(80752);
    expect(b.body.data._id).toBe(String(cat.gold._id));
  });

  it("GET /api/products/:id unknown → 404 (valid ObjectId and plain string)", async () => {
    expect((await ctx.api().get("/api/products/0123456789abcdef01234567")).status).toBe(404);
    expect((await ctx.api().get("/api/products/nope")).status).toBe(404);
  });

  it("missing rate: product still listed, but with no computed price", async () => {
    await seedRates({ silver: null });
    await createProduct("silver");
    const res = await ctx.api().get("/api/products/silver-anklet");
    expect(res.status).toBe(200);
    expect(res.body.data.priceBreakdown).toBeUndefined();
  });

  it("discountPercentage yields a discountPrice off the computed price", async () => {
    await seedRates();
    await createProduct("gold", { discountPercentage: 10 });
    const res = await ctx.api().get("/api/products/gold-ring");
    expect(res.body.data.discountPrice).toBeCloseTo(80752 * 0.9, 5);
  });
});

describe("GET /api/products/filter", () => {
  it("category, price band and ordering", async () => {
    await seedCatalog();
    const res = await ctx.api().get("/api/products/filter?minPrice=2000&maxPrice=20000&priceOrder=high-to-low");
    expect(res.body.map((p) => p.productId)).toEqual(["one-of-a-kind", "silver-anklet"]);
    const silver = await ctx.api().get("/api/products/filter?category=Silver");
    expect(silver.body.map((p) => p.productId)).toEqual(["silver-anklet"]);
  });

  it("category=All and category=undefined mean no filter", async () => {
    await seedCatalog();
    const all = await ctx.api().get("/api/products/filter?category=All");
    const und = await ctx.api().get("/api/products/filter?category=undefined");
    expect(all.body.length).toBe(und.body.length);
    expect(all.body.length).toBeGreaterThan(1);
  });

  it("search matches name or category, case-insensitively", async () => {
    await seedCatalog();
    const res = await ctx.api().get("/api/products/filter?search=ANKLET");
    expect(res.body.map((p) => p.productId)).toEqual(["silver-anklet"]);
  });

  it("empty DB → []", async () => {
    expect((await ctx.api().get("/api/products/filter")).body).toEqual([]);
  });
});

describe("GET /api/products/search", () => {
  it("q filters; no q returns everything", async () => {
    await seedCatalog();
    const hit = await ctx.api().get("/api/products/search?q=ring");
    expect(hit.body.data.map((p) => p.productId)).toEqual(["gold-ring"]);
    const all = await ctx.api().get("/api/products/search");
    expect(all.body.data).toHaveLength(5);
  });
});

// ─── View tracking ───────────────────────────────────────────────────────────

describe("POST /api/products/:id/view", () => {
  it("counts once per session inside 30 minutes; a new session counts again", async () => {
    const cat = await seedCatalog();
    const view = (sessionId, id = "gold-ring") => ctx.api().post(`/api/products/${id}/view`).send({ sessionId });
    expect((await view("s1")).body).toEqual({ success: true, counted: true });
    expect((await view("s1")).body).toEqual({ success: true, counted: false });
    expect((await view("s1", String(cat.gold._id))).body.counted).toBe(false); // same product via _id
    expect((await view("s2")).body.counted).toBe(true);
    expect(await ProductView.countDocuments()).toBe(2);
  });

  it("counts again once the previous view is older than 30 minutes", async () => {
    await seedCatalog();
    await ctx.api().post("/api/products/gold-ring/view").send({ sessionId: "s1" });
    await ProductView.updateMany({}, { viewedAt: new Date(Date.now() - 31 * 60 * 1000) });
    expect((await ctx.api().post("/api/products/gold-ring/view").send({ sessionId: "s1" })).body.counted).toBe(true);
  });

  it("attributes the view to a signed-in user; guests are null", async () => {
    await seedCatalog();
    const c = await makeCustomer();
    await ctx.api(c.token).post("/api/products/gold-ring/view").send({ sessionId: "a" });
    await ctx.api().post("/api/products/gold-ring/view").send({ sessionId: "b" });
    const views = await ProductView.find().sort({ sessionId: 1 }).lean();
    expect(views[0].userId).toBe(String(c.user._id));
    expect(views[1].userId).toBeNull();
  });

  it("an invalid token is treated as a guest, not an error", async () => {
    await seedCatalog();
    const res = await ctx.api("garbage").post("/api/products/gold-ring/view").send({ sessionId: "a" });
    expect(res.status).toBe(201);
  });

  it("missing / over-long sessionId → 400; unknown product → 404", async () => {
    await seedCatalog();
    expect((await ctx.api().post("/api/products/gold-ring/view").send({})).status).toBe(400);
    expect((await ctx.api().post("/api/products/gold-ring/view").send({ sessionId: "x".repeat(65) })).status).toBe(400);
    expect((await ctx.api().post("/api/products/nope/view").send({ sessionId: "a" })).status).toBe(404);
  });
});

// ─── Products: admin CRUD ────────────────────────────────────────────────────

describe("admin product CRUD", () => {
  it("create → 201 with a generated productId; numeric strings coerced", async () => {
    const { token } = await makeAdmin();
    const res = await ctx.api(token).post("/api/products").send({
      name: "New Bangle", category: "Gold", metalType: "gold", weight: "8.5", wastagePercent: "10", gstPercent: "3", stock: "2",
    });
    expect(res.status).toBe(201);
    expect(res.body.data.productId).toMatch(/^p-\d+$/);
    expect(res.body.data).toMatchObject({ weight: 8.5, wastagePercent: 10, gstPercent: 3, stock: 2 });
  });

  it("create keeps size and carate (previously dropped by strict mode)", async () => {
    const { token } = await makeAdmin();
    const res = await ctx.api(token).post("/api/products").send({ name: "R", category: "Gold", size: "12", carate: 22 });
    expect(res.body.data).toMatchObject({ size: "12", carate: 22 });
  });

  it.each([
    [{ category: "Gold" }, /Product name is required/],
    [{ name: "X" }, /Category is required/],
    [{ name: "X", category: "Gold", wastagePercent: 150 }, /between 0 and 100/],
    [{ name: "X", category: "Gold", metalType: "platinum" }, /./],
    [{ name: "X", category: "Gold", weight: "heavy" }, /./],
  ])("create validation %j → 400", async (body, msg) => {
    const { token } = await makeAdmin();
    const res = await ctx.api(token).post("/api/products").send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(msg);
  });

  it("update by _id or productId; live price follows", async () => {
    const cat = await seedCatalog();
    const { token } = await makeAdmin();
    await ctx.api(token).patch(`/api/products/${cat.gold._id}`).send({ weight: 20 });
    const p = await ctx.api().get("/api/products/gold-ring");
    expect(p.body.data.price).toBe(80752 * 2);
    const byPid = await ctx.api(token).patch("/api/products/gold-ring").send({ isActive: false });
    expect(byPid.body.data.isActive).toBe(false);
  });

  it("update unknown → 404; invalid body → 400", async () => {
    await seedCatalog();
    const { token } = await makeAdmin();
    expect((await ctx.api(token).patch("/api/products/nope").send({ stock: 1 })).status).toBe(404);
    expect((await ctx.api(token).patch("/api/products/gold-ring").send({ gstPercent: 500 })).status).toBe(400);
  });

  it("delete by productId → 200, then 404", async () => {
    await seedCatalog();
    const { token } = await makeAdmin();
    expect((await ctx.api(token).delete("/api/products/gold-ring")).status).toBe(200);
    expect(await Product.countDocuments({ productId: "gold-ring" })).toBe(0);
    expect((await ctx.api(token).delete("/api/products/gold-ring")).status).toBe(404);
  });
});

// ─── Categories ──────────────────────────────────────────────────────────────

describe("categories", () => {
  it("GET lists categories with a live itemCount; empty DB → []", async () => {
    expect((await ctx.api().get("/api/categories")).body).toEqual([]);
    await seedCatalog();
    await Category.create({ categoryName: "Gold" });
    const res = await ctx.api().get("/api/categories");
    expect(res.body[0]).toMatchObject({ categoryName: "Gold", itemCount: 2 });
  });

  it("admin create / update / delete", async () => {
    const { token } = await makeAdmin();
    const created = await ctx.api(token).post("/api/categories").send({ categoryName: "Bridal", categoryPic: "https://x/y.jpg", name: "ignored" });
    expect(created.status).toBe(201);
    const id = created.body.insertedId;
    expect(created.body.data.name).toBeUndefined();
    const updated = await ctx.api(token).patch(`/api/categories/${id}`).send({ categoryName: "Bridal Sets" });
    expect(updated.body.data.categoryName).toBe("Bridal Sets");
    expect((await ctx.api(token).delete(`/api/categories/${id}`)).status).toBe(200);
    expect((await ctx.api(token).delete(`/api/categories/${id}`)).status).toBe(404);
    expect((await ctx.api(token).patch(`/api/categories/${id}`).send({ categoryName: "Z" })).status).toBe(404);
  });

  it("validation: categoryName required, ≤100 chars", async () => {
    const { token } = await makeAdmin();
    expect((await ctx.api(token).post("/api/categories").send({})).status).toBe(400);
    expect((await ctx.api(token).post("/api/categories").send({ categoryName: "x".repeat(101) })).status).toBe(400);
  });
});
