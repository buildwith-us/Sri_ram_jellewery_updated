import { describe, it, expect } from "vitest";
import { computePrice } from "../../server/utils/computePrice.js";

const RATES = { gold: 7000, silver: 90 };

describe("computePrice", () => {
  it("gold: metal + wastage + GST on (metal+wastage), with a correct breakdown", () => {
    // 10g × 7000 = 70,000; 12% wastage = 8,400; subtotal 78,400; 3% GST = 2,352.
    const r = computePrice({ weight: 10, wastagePercent: 12, gstPercent: 3, metalType: "gold" }, RATES);
    expect(r).toEqual({
      finalPrice: 80752,
      priceBreakdown: { metalValue: 70000, wastageValue: 8400, gst: 2352, ratePerGram: 7000 },
    });
  });

  it("silver uses the silver rate, not gold", () => {
    // 50g × 90 = 4,500; 10% = 450; subtotal 4,950; GST 148.5; final 5,098.5 → 5,099.
    const r = computePrice({ weight: 50, wastagePercent: 10, gstPercent: 3, metalType: "silver" }, RATES);
    expect(r.finalPrice).toBe(5099);
    expect(r.priceBreakdown.ratePerGram).toBe(90);
    expect(r.priceBreakdown.metalValue).toBe(4500);
    expect(r.priceBreakdown.wastageValue).toBe(450);
    expect(r.priceBreakdown.gst).toBe(149); // 148.5 rounds half up
  });

  it("rounds the final price to the nearest rupee (half up)", () => {
    // 1.5g × 90 = 135, no wastage, 3% GST = 4.05 → 139.05 → 139.
    expect(computePrice({ weight: 1.5, gstPercent: 3, metalType: "silver" }, RATES).finalPrice).toBe(139);
    // 0.5g × 7001 = 3500.5 → 3501.
    expect(computePrice({ weight: 0.5, metalType: "gold" }, { gold: 7001 }).finalPrice).toBe(3501);
    // Result is always an integer.
    const odd = computePrice({ weight: 3.333, wastagePercent: 7.7, gstPercent: 3, metalType: "gold" }, { gold: 7123 });
    expect(Number.isInteger(odd.finalPrice)).toBe(true);
  });

  it("GST is computed on metal + wastage, not metal alone", () => {
    const r = computePrice({ weight: 10, wastagePercent: 10, gstPercent: 10, metalType: "gold" }, { gold: 1000 });
    // metal 10,000; wastage 1,000; GST 10% of 11,000 = 1,100 (not 1,000).
    expect(r.priceBreakdown.gst).toBe(1100);
    expect(r.finalPrice).toBe(12100);
  });

  it("zero wastage and zero GST give the bare metal value", () => {
    expect(computePrice({ weight: 4, metalType: "gold" }, RATES).finalPrice).toBe(28000);
  });

  it("quote-only → undefined, even with weight and a rate", () => {
    expect(computePrice({ weight: 10, isQuoteOnly: true, metalType: "gold" }, RATES)).toBeUndefined();
  });

  it("weight 0 → the stored price, with no breakdown", () => {
    expect(computePrice({ weight: 0, price: 1500 }, RATES)).toEqual({ finalPrice: 1500, priceBreakdown: null });
  });

  it("missing weight is treated as weight 0", () => {
    expect(computePrice({ price: 750 }, RATES)).toEqual({ finalPrice: 750, priceBreakdown: null });
  });

  it("weight 0 needs no rate at all", () => {
    expect(computePrice({ weight: 0, price: 1500 }, {})).toEqual({ finalPrice: 1500, priceBreakdown: null });
    expect(computePrice({ weight: 0, price: 1500 }, null)).toEqual({ finalPrice: 1500, priceBreakdown: null });
  });

  it("missing rate for the metal → undefined (never a stale or partial price)", () => {
    expect(computePrice({ weight: 5, metalType: "silver" }, { gold: 7000 })).toBeUndefined();
    expect(computePrice({ weight: 5, metalType: "gold" }, {})).toBeUndefined();
    expect(computePrice({ weight: 5, metalType: "gold" }, null)).toBeUndefined();
    expect(computePrice({ weight: 5, metalType: "gold" }, undefined)).toBeUndefined();
    expect(computePrice({ weight: 5, metalType: "gold" }, { gold: 0 })).toBeUndefined();
  });

  it("isFixedPrice is ignored: true, false and absent all price from the rate", () => {
    const base = { weight: 10, wastagePercent: 12, gstPercent: 3, metalType: "gold", price: 999 };
    const a = computePrice({ ...base, isFixedPrice: true }, RATES);
    const b = computePrice({ ...base, isFixedPrice: false }, RATES);
    const c = computePrice(base, RATES);
    expect(a).toEqual(c);
    expect(b).toEqual(c);
    expect(b.finalPrice).toBe(80752); // not the 999 making charge
  });

  it("metalType defaults to gold", () => {
    expect(computePrice({ weight: 1 }, RATES).finalPrice).toBe(7000);
    expect(computePrice({ weight: 1, metalType: null }, RATES).finalPrice).toBe(7000);
  });

  it("an unknown metalType has no rate → undefined", () => {
    expect(computePrice({ weight: 1, metalType: "platinum" }, RATES)).toBeUndefined();
  });

  it("the stored price (making charge) never leaks into a weighted price", () => {
    const withCharge = computePrice({ weight: 1, price: 5000, metalType: "gold" }, RATES);
    const without = computePrice({ weight: 1, metalType: "gold" }, RATES);
    expect(withCharge).toEqual(without);
  });
});
