import { describe, it, expect, afterEach, vi } from "vitest";
import {
  RATE_BOUNDS,
  RATE_STALE_AFTER_DAYS,
  isRateStale,
  rateAgeInDays,
  rateOutOfBoundsMessage,
} from "../../server/utils/rateGuards.js";
import { updateRatesSchema } from "../../server/middleware/validate.js";
import { findStaleMetalsForProducts, findUnpriceableMetalsForProducts } from "../../server/utils/getRates.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-27T12:00:00.000Z").getTime();

afterEach(() => {
  vi.useRealTimers();
});

describe("RATE_BOUNDS via updateRatesSchema", () => {
  const ok = (body) => updateRatesSchema.safeParse(body).success;

  it("has the documented bands", () => {
    expect(RATE_BOUNDS).toEqual({ gold: { min: 2000, max: 50000 }, silver: { min: 20, max: 5000 } });
  });

  it.each([
    [1999, false],
    [2000, true],
    [50000, true],
    [50001, false],
  ])("gold %i → %s", (gold, expected) => {
    expect(ok({ gold })).toBe(expected);
  });

  it.each([
    [19, false],
    [20, true],
    [5000, true],
    [5001, false],
  ])("silver %i → %s", (silver, expected) => {
    expect(ok({ silver })).toBe(expected);
  });

  it("the ₹96/g gold slip that reached production is refused", () => {
    expect(ok({ gold: 96 })).toBe(false);
  });

  it("numeric strings are coerced (HTML forms)", () => {
    const r = updateRatesSchema.safeParse({ gold: "7250", silver: "95" });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ gold: 7250, silver: 95 });
  });

  it("non-numeric strings, NaN and empty body are refused", () => {
    expect(ok({ gold: "abc" })).toBe(false);
    expect(ok({ gold: NaN })).toBe(false);
    expect(ok({})).toBe(false);
  });

  it("the message is shared with the admin form", () => {
    const r = updateRatesSchema.safeParse({ gold: 1 });
    expect(r.error.issues[0].message).toBe(rateOutOfBoundsMessage("gold"));
    expect(rateOutOfBoundsMessage("gold")).toMatch(/2,000.*50,000/);
    expect(rateOutOfBoundsMessage("silver")).toMatch(/Silver.*20.*5,000/);
  });
});

describe("isRateStale", () => {
  it("defaults to 3 days", () => {
    expect(RATE_STALE_AFTER_DAYS).toBe(3);
  });

  it("fresh rate is not stale", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    expect(isRateStale(new Date(NOW - 60_000))).toBe(false);
  });

  it("exactly 3 days old is NOT stale; 1 ms over is", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    expect(isRateStale(new Date(NOW - 3 * DAY))).toBe(false);
    expect(isRateStale(new Date(NOW - 3 * DAY - 1))).toBe(true);
  });

  it("null, undefined and invalid dates are stale (fail closed)", () => {
    expect(isRateStale(null)).toBe(true);
    expect(isRateStale(undefined)).toBe(true);
    expect(isRateStale("not a date")).toBe(true);
    expect(isRateStale(new Date("garbage"))).toBe(true);
  });

  it("accepts ISO strings as well as Date objects", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    expect(isRateStale(new Date(NOW - DAY).toISOString())).toBe(false);
  });

  it("a future timestamp (clock skew) is not stale", () => {
    expect(isRateStale(new Date(Date.now() + DAY))).toBe(false);
  });

  it("RATE_STALE_AFTER_DAYS env var changes the window", async () => {
    vi.resetModules();
    process.env.RATE_STALE_AFTER_DAYS = "1";
    try {
      const mod = await import("../../server/utils/rateGuards.js");
      expect(mod.RATE_STALE_AFTER_DAYS).toBe(1);
      expect(mod.isRateStale(new Date(Date.now() - 1.5 * DAY))).toBe(true);
    } finally {
      delete process.env.RATE_STALE_AFTER_DAYS;
      vi.resetModules();
    }
  });

  it("RATE_STALE_AFTER_DAYS=0 or garbage falls back to 3", async () => {
    for (const v of ["0", "abc", ""]) {
      vi.resetModules();
      process.env.RATE_STALE_AFTER_DAYS = v;
      const mod = await import("../../server/utils/rateGuards.js");
      expect(mod.RATE_STALE_AFTER_DAYS).toBe(3);
    }
    delete process.env.RATE_STALE_AFTER_DAYS;
    vi.resetModules();
  });
});

describe("rateAgeInDays", () => {
  it("floors whole days and handles null/invalid", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    expect(rateAgeInDays(new Date(NOW - 2.9 * DAY))).toBe(2);
    expect(rateAgeInDays(new Date(NOW))).toBe(0);
    expect(rateAgeInDays(null)).toBeNull();
    expect(rateAgeInDays("garbage")).toBeNull();
  });
});

describe("findStaleMetalsForProducts", () => {
  const gold = { weight: 5, metalType: "gold" };
  const silver = { weight: 5, metalType: "silver" };

  it("returns only metals that are both stale and in the basket", () => {
    expect(findStaleMetalsForProducts([gold, silver], ["silver"])).toEqual(["silver"]);
    expect(findStaleMetalsForProducts([gold], ["silver"])).toEqual([]);
    expect(findStaleMetalsForProducts([gold, silver], ["gold", "silver"]).sort()).toEqual(["gold", "silver"]);
  });

  it("ignores quote-only and weightless products (not rate-priced)", () => {
    expect(findStaleMetalsForProducts([{ weight: 0, metalType: "gold" }], ["gold"])).toEqual([]);
    expect(findStaleMetalsForProducts([{ weight: 5, isQuoteOnly: true }], ["gold"])).toEqual([]);
  });

  it("missing metalType counts as gold; null entries are skipped", () => {
    expect(findStaleMetalsForProducts([{ weight: 1 }, null], ["gold"])).toEqual(["gold"]);
  });

  it("nothing stale → nothing affected", () => {
    expect(findStaleMetalsForProducts([gold, silver], [])).toEqual([]);
  });
});

describe("findUnpriceableMetalsForProducts (B3)", () => {
  const gold = { weight: 5, metalType: "gold" };
  const silver = { weight: 5, metalType: "silver" };
  const both = { gold: 7000, silver: 90 };

  it("a metal with no rate, or a zero rate, is unpriceable", () => {
    expect(findUnpriceableMetalsForProducts([gold, silver], { rateMap: { gold: 7000 }, staleMetals: [] })).toEqual(["silver"]);
    expect(findUnpriceableMetalsForProducts([gold], { rateMap: { gold: 0 }, staleMetals: [] })).toEqual(["gold"]);
    expect(findUnpriceableMetalsForProducts([gold], { rateMap: {}, staleMetals: [] })).toEqual(["gold"]);
  });

  it("stale and missing are reported together", () => {
    const r = findUnpriceableMetalsForProducts([gold, silver], { rateMap: { gold: 7000 }, staleMetals: ["gold"] });
    expect(r.sort()).toEqual(["gold", "silver"]);
  });

  it("quote-only and weightless products never need a rate", () => {
    const products = [{ weight: 0, metalType: "silver" }, { weight: 5, metalType: "silver", isQuoteOnly: true }];
    expect(findUnpriceableMetalsForProducts(products, { rateMap: {}, staleMetals: [] })).toEqual([]);
  });

  it("all rates present and fresh → nothing affected", () => {
    expect(findUnpriceableMetalsForProducts([gold, silver], { rateMap: both, staleMetals: [] })).toEqual([]);
  });

  it("rateMap null checks staleness only (findStaleMetalsForProducts)", () => {
    expect(findUnpriceableMetalsForProducts([gold], { rateMap: null, staleMetals: [] })).toEqual([]);
  });
});
