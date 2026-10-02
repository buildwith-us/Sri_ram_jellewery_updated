import { describe, it, expect } from "vitest";
import { useApp } from "../helpers/app.js";
import { createProduct, insertOrder, stockOf } from "../helpers/factories.js";
import {
  reserveStock,
  releaseStock,
  releaseStaleReservations,
  outOfStockMessage,
  STOCK_RELEASE_MINUTES,
  EXPIRY_REASON,
} from "../../server/utils/stock.js";
import { Order } from "../../server/models/Order.js";

useApp();

const minutesAgo = (m) => new Date(Date.now() - m * 60 * 1000);

describe("reserveStock", () => {
  it("decrements every line when all are available", async () => {
    await createProduct("gold");
    await createProduct("silver");
    const r = await reserveStock([
      { productId: "gold-ring", quantity: 2 },
      { productId: "silver-anklet", quantity: 5 },
    ]);
    expect(r).toEqual({ ok: true });
    expect(await stockOf("gold-ring")).toBe(3);
    expect(await stockOf("silver-anklet")).toBe(0);
  });

  it("quantity defaults to 1", async () => {
    await createProduct("gold");
    await reserveStock([{ productId: "gold-ring" }]);
    expect(await stockOf("gold-ring")).toBe(4);
  });

  it("resolves a line by Mongo _id as well as productId", async () => {
    const p = await createProduct("gold");
    expect((await reserveStock([{ productId: String(p._id), quantity: 1 }])).ok).toBe(true);
    expect(await stockOf("gold-ring")).toBe(4);
  });

  it("rolls back earlier lines when a later line fails, and reports the failing line", async () => {
    await createProduct("gold"); // stock 5
    await createProduct("single"); // stock 1
    const r = await reserveStock([
      { productId: "gold-ring", quantity: 2 },
      { productId: "one-of-a-kind", quantity: 2, name: "One Of A Kind Pendant" },
    ]);
    expect(r).toEqual({ ok: false, product: "One Of A Kind Pendant", available: 1 });
    expect(await stockOf("gold-ring")).toBe(5);
    expect(await stockOf("one-of-a-kind")).toBe(1);
  });

  it("rolls back when a later line's product does not exist", async () => {
    await createProduct("gold");
    const r = await reserveStock([
      { productId: "gold-ring", quantity: 1 },
      { productId: "no-such-thing", quantity: 1 },
    ]);
    expect(r.ok).toBe(false);
    expect(r.available).toBe(0);
    expect(r.product).toBe("This piece");
    expect(await stockOf("gold-ring")).toBe(5);
  });

  it("never takes stock below zero under concurrency", async () => {
    await createProduct("single");
    const results = await Promise.all(
      Array.from({ length: 10 }, () => reserveStock([{ productId: "one-of-a-kind", quantity: 1 }]))
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await stockOf("one-of-a-kind")).toBe(0);
  });

  it("a stock-0 product cannot be reserved", async () => {
    await createProduct("gold", { stock: 0 });
    const r = await reserveStock([{ productId: "gold-ring", quantity: 1 }]);
    expect(r).toMatchObject({ ok: false, available: 0 });
  });
});

describe("releaseStock", () => {
  it("adds each line's quantity back", async () => {
    await createProduct("gold");
    await releaseStock([{ productId: "gold-ring", quantity: 3 }, { productId: "gold-ring" }]);
    expect(await stockOf("gold-ring")).toBe(9);
  });

  it("ignores lines for products that no longer exist", async () => {
    await expect(releaseStock([{ productId: "deleted-product", quantity: 1 }])).resolves.toBeUndefined();
  });
});

describe("releaseStaleReservations", () => {
  const staleOnline = (over = {}) =>
    insertOrder({
      paymentMethod: "razorpay",
      paymentStatus: "pending",
      orderStatus: "pending",
      createdAt: minutesAgo(STOCK_RELEASE_MINUTES + 5),
      ...over,
    });

  it("expires and restocks an unpaid online order older than the window", async () => {
    await createProduct("gold", { stock: 4 });
    const o = await staleOnline();
    const r = await releaseStaleReservations();
    expect(r.scanned).toBe(1);
    expect(r.released).toHaveLength(1);
    expect(r.released[0]).toMatchObject({ orderId: o.orderId, items: [{ productId: "gold-ring", quantity: 1 }] });
    expect(r.windowMinutes).toBe(30);
    expect(await stockOf("gold-ring")).toBe(5);
    const after = await Order.findById(o._id).lean();
    expect(after).toMatchObject({
      orderStatus: "expired",
      paymentStatus: "expired",
      stockReserved: false,
      cancellationReason: EXPIRY_REASON,
    });
    expect(after.expiredAt).toBeInstanceOf(Date);
  });

  it("never touches COD, whatever its paymentStatus", async () => {
    await createProduct("gold", { stock: 4 });
    await insertOrder({ paymentMethod: "cod", paymentStatus: "unpaid", createdAt: minutesAgo(600) });
    await insertOrder({ paymentMethod: "cod", paymentStatus: "pending", createdAt: minutesAgo(600) });
    const r = await releaseStaleReservations();
    expect(r.released).toHaveLength(0);
    expect(await stockOf("gold-ring")).toBe(4);
  });

  it("never touches a paid order", async () => {
    await createProduct("gold", { stock: 4 });
    await staleOnline({ paidAt: minutesAgo(40), paymentStatus: "paid" });
    await staleOnline({ paidAt: minutesAgo(40) }); // paidAt set even if status lagged
    expect((await releaseStaleReservations()).released).toHaveLength(0);
    expect(await stockOf("gold-ring")).toBe(4);
  });

  it("never touches a fresh order inside the window", async () => {
    await createProduct("gold", { stock: 4 });
    await staleOnline({ createdAt: minutesAgo(STOCK_RELEASE_MINUTES - 1) });
    expect((await releaseStaleReservations()).released).toHaveLength(0);
    expect(await stockOf("gold-ring")).toBe(4);
  });

  it("never touches an order that holds no reservation", async () => {
    await createProduct("gold", { stock: 4 });
    await staleOnline({ stockReserved: false });
    expect((await releaseStaleReservations()).released).toHaveLength(0);
    expect(await stockOf("gold-ring")).toBe(4);
  });

  it("honours an explicit window and a supplied clock", async () => {
    await createProduct("gold", { stock: 4 });
    await staleOnline({ createdAt: minutesAgo(10) });
    expect((await releaseStaleReservations({ windowMinutes: 15 })).released).toHaveLength(0);
    expect((await releaseStaleReservations({ windowMinutes: 5 })).released).toHaveLength(1);
  });

  it("two overlapping sweeps restock an order exactly once", async () => {
    await createProduct("gold", { stock: 4 });
    await staleOnline();
    const [a, b] = await Promise.all([releaseStaleReservations(), releaseStaleReservations()]);
    expect(a.released.length + b.released.length).toBe(1);
    expect(await stockOf("gold-ring")).toBe(5);
  });
});

describe("outOfStockMessage", () => {
  it("says how many are left, or that it sold out", () => {
    expect(outOfStockMessage({ product: "Ring", available: 2 })).toMatch(/only 2 left/);
    expect(outOfStockMessage({ product: "Ring", available: 0 })).toMatch(/sold out/);
  });
});
