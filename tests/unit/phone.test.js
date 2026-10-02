import { describe, it, expect } from "vitest";
import { normalizeIndianPhone, phoneVariants, CANONICAL_PHONE } from "../../server/utils/phone.js";

const CANON = "+919876543210";

describe("normalizeIndianPhone — accepted shapes", () => {
  it.each([
    ["bare 10 digits", "9876543210"],
    ["+91 prefix", "+919876543210"],
    ["+91 with space", "+91 9876543210"],
    ["91 prefix, 12 digits", "919876543210"],
    ["0091 prefix", "00919876543210"],
    ["0 trunk prefix, 11 digits", "09876543210"],
    ["spaces", "98765 43210"],
    ["dashes", "98765-43210"],
    ["mixed", "+91-98765 43210"],
    ["brackets and dots", "(98765) 432.10"],
    ["surrounding whitespace", "  9876543210  "],
    ["number type", 9876543210],
  ])("%s → canonical", (_label, input) => {
    expect(normalizeIndianPhone(input)).toEqual({ ok: true, phone: CANON });
  });

  it.each(["6", "7", "8", "9"])("leading %s is a valid mobile prefix", (d) => {
    const r = normalizeIndianPhone(`${d}123456789`);
    expect(r.ok).toBe(true);
    expect(r.phone).toMatch(CANONICAL_PHONE);
  });

  it("a 10-digit number that happens to start with 91 is NOT stripped", () => {
    expect(normalizeIndianPhone("9198765432")).toEqual({ ok: true, phone: "+919198765432" });
  });
});

describe("normalizeIndianPhone — rejected shapes", () => {
  it.each(["0", "1", "2", "3", "4", "5"])("leading %s is refused", (d) => {
    const r = normalizeIndianPhone(`${d}123456789`);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/starting with 6, 7, 8 or 9/);
  });

  it("9 digits", () => {
    expect(normalizeIndianPhone("987654321").ok).toBe(false);
  });

  it("11 digits without a leading 0", () => {
    expect(normalizeIndianPhone("98765432101").ok).toBe(false);
  });

  it("11 digits starting 91 (a truncated +91 number)", () => {
    expect(normalizeIndianPhone("91987654321").ok).toBe(false);
  });

  it("13 digits", () => {
    expect(normalizeIndianPhone("9198765432101").ok).toBe(false);
  });

  it("letters are refused, not stripped", () => {
    const r = normalizeIndianPhone("98765O3210");
    expect(r).toEqual({ ok: false, reason: "Phone number may contain digits only" });
  });

  it("non-Indian country code", () => {
    const r = normalizeIndianPhone("+1 2025550123");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Indian/);
  });

  it("a second + after the prefix", () => {
    expect(normalizeIndianPhone("+91+9876543210").ok).toBe(false);
  });

  it.each([undefined, null, "", "   ", "-- ()"])("empty-ish input %s → required", (input) => {
    expect(normalizeIndianPhone(input)).toEqual({ ok: false, reason: "Phone number is required" });
  });

  it("objects and arrays do not crash", () => {
    expect(normalizeIndianPhone({}).ok).toBe(false);
    expect(normalizeIndianPhone(["9876543210", "x"]).ok).toBe(false);
  });
});

describe("phoneVariants", () => {
  it("lists every legacy spelling of a canonical number", () => {
    expect(phoneVariants(CANON)).toEqual([
      "+919876543210",
      "9876543210",
      "919876543210",
      "09876543210",
      "+91 9876543210",
    ]);
  });

  it("every variant normalises back to the canonical form", () => {
    for (const v of phoneVariants(CANON)) {
      expect(normalizeIndianPhone(v).phone).toBe(CANON);
    }
  });
});
