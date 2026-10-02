import { describe, it, expect } from "vitest";
import { useApp } from "../helpers/app.js";
import { createProduct, insertOrder, stockOf } from "../helpers/factories.js";
import { Order } from "../../server/models/Order.js";

const ctx = useApp();
const sweep = (auth) => {
  const t = ctx.api().get("/api/cron/release-stale-reservations");
  return auth === undefined ? t : t.set("Authorization", auth);
};
const hourAgo = () => new Date(Date.now() - 60 * 60 * 1000);

describe("cron auth", () => {
  it("CRON_SECRET unset → 503 (fails closed)", async () => {
    const saved = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    try {
      expect((await sweep("Bearer anything")).status).toBe(503);
      expect((await ctx.api().get("/api/cron/health")).status).toBe(503);
    } finally {
      process.env.CRON_SECRET = saved;
    }
  });

  it("missing header → 401", async () => {
    expect((await sweep()).status).toBe(401);
  });

  it("wrong secret → 401", async () => {
    expect((await sweep("Bearer wrong")).status).toBe(401);
  });

  it("empty bearer → 401", async () => {
    expect((await sweep("Bearer ")).status).toBe(401);
  });

  it("correct secret → 200 with the sweep summary", async () => {
    const res = await sweep(`Bearer ${process.env.CRON_SECRET}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, scanned: 0, released: [], windowMinutes: 30 });
  });

  it("health reports the configured window", async () => {
    const res = await ctx.api().get("/api/cron/health").set("Authorization", `Bearer ${process.env.CRON_SECRET}`);
    expect(res.body).toEqual({ success: true, stockReleaseMinutes: 30 });
  });
});

describe("cron sweep", () => {
  it("expires only stale unpaid online orders and restocks them", async () => {
    await createProduct("gold", { stock: 3 });
    const stale = await insertOrder({ paymentMethod: "razorpay", paymentStatus: "pending", orderStatus: "pending", createdAt: hourAgo() });
    const fresh = await insertOrder({ paymentMethod: "razorpay", paymentStatus: "pending", orderStatus: "pending" });
    const paid = await insertOrder({ paymentMethod: "razorpay", paymentStatus: "paid", paidAt: hourAgo(), createdAt: hourAgo() });
    const cod = await insertOrder({ paymentMethod: "cod", paymentStatus: "unpaid", createdAt: hourAgo() });

    const res = await sweep(`Bearer ${process.env.CRON_SECRET}`);
    expect(res.body.released.map((r) => r.orderId)).toEqual([stale.orderId]);
    expect(await stockOf("gold-ring")).toBe(4);

    const status = async (o) => (await Order.findById(o._id).lean()).orderStatus;
    expect(await status(stale)).toBe("expired");
    expect(await status(fresh)).toBe("pending");
    expect(await status(paid)).toBe("processing");
    expect(await status(cod)).toBe("processing");
  });

  it("running twice does not restock twice", async () => {
    await createProduct("gold", { stock: 3 });
    await insertOrder({ paymentMethod: "razorpay", paymentStatus: "pending", orderStatus: "pending", createdAt: hourAgo() });
    await sweep(`Bearer ${process.env.CRON_SECRET}`);
    await sweep(`Bearer ${process.env.CRON_SECRET}`);
    expect(await stockOf("gold-ring")).toBe(4);
  });
});
