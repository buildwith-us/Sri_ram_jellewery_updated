/**
 * server/db/connect.js on its own: first-run seeding, connection reuse, and
 * what happens when the database cannot be reached. Runs without useApp() so
 * connectDB() does the connecting itself.
 */
import { describe, it, expect, inject, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import bcrypt from "bcrypt";

const base = inject("mongoUri").replace(/\/$/, "");
const freshDb = () => `${base}/seed_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;

let connectDB;
beforeEach(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.dropDatabase().catch(() => {});
    await mongoose.disconnect();
  }
  globalThis.__mongooseCache = { conn: null, promise: null };
  connectDB = (await import("../../server/db/connect.js")).default;
});

afterAll(async () => {
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

describe("connectDB", () => {
  it("seeds an empty database once: 5 products, 2 fresh rates, 3 categories, the admin", async () => {
    process.env.MONGODB_URI = freshDb();
    const conn = await connectDB();
    expect(conn).toBeTruthy();
    const { Product } = await import("../../server/models/Product.js");
    const { GoldRate } = await import("../../server/models/GoldRate.js");
    const { Category } = await import("../../server/models/Category.js");
    const { User } = await import("../../server/models/User.js");
    expect(await Product.countDocuments()).toBe(5);
    expect(await Category.countDocuments()).toBe(3);
    const rates = await GoldRate.find().lean();
    expect(rates.map((r) => r.metalType).sort()).toEqual(["gold", "silver"]);
    const admin = await User.findOne({ email: "admin@buildwithus" }).lean();
    expect(admin.role).toBe("ADMIN");
    expect(await bcrypt.compare(process.env.ADMIN_PASSWORD, admin.passwordHash)).toBe(true);
    // The shared-password test account is development-only.
    expect(await User.findOne({ email: "user@test.com" })).toBeNull();

    // Second call reuses the connection and does not re-seed.
    expect(await connectDB()).toBe(conn);
    expect(await Product.countDocuments()).toBe(5);
  });

  it("seeded catalogue passes the rate guards and prices sensibly", async () => {
    process.env.MONGODB_URI = freshDb();
    await connectDB();
    const { Product } = await import("../../server/models/Product.js");
    const { getRates } = await import("../../server/utils/getRates.js");
    const { computePrice } = await import("../../server/utils/computePrice.js");
    const { updateRatesSchema } = await import("../../server/middleware/validate.js");
    const rates = await getRates();
    expect(updateRatesSchema.safeParse(rates).success).toBe(true);
    const p1 = await Product.findOne({ productId: "p1" }).lean();
    // 12.5 g × 7250 × 1.12 × 1.03 = 104,545
    expect(computePrice(p1, rates).finalPrice).toBe(104545);
  });

  it("skips the admin when ADMIN_PASSWORD is unset (no literal fallback)", async () => {
    process.env.MONGODB_URI = freshDb();
    const saved = process.env.ADMIN_PASSWORD;
    delete process.env.ADMIN_PASSWORD;
    try {
      await connectDB();
      const { User } = await import("../../server/models/User.js");
      expect(await User.countDocuments()).toBe(0);
    } finally {
      process.env.ADMIN_PASSWORD = saved;
    }
  });

  it("does not re-seed a database that already has products", async () => {
    const uri = freshDb();
    await mongoose.connect(uri);
    const { Product } = await import("../../server/models/Product.js");
    await Product.create({ productId: "mine", name: "Mine", category: "Gold" });
    await mongoose.disconnect();
    globalThis.__mongooseCache = { conn: null, promise: null };
    process.env.MONGODB_URI = uri;
    await connectDB();
    expect(await Product.countDocuments()).toBe(1);
  });

  it("outside development an unreachable DB resolves undefined instead of throwing (so index.js's 503 branch never runs)", async () => {
    process.env.MONGODB_URI = "notmongo://nowhere";
    await expect(connectDB()).resolves.toBeUndefined();
  });

  it("MONGODB_URI unset → resolves undefined, no crash", async () => {
    delete process.env.MONGODB_URI;
    await expect(connectDB()).resolves.toBeUndefined();
  });
});
