import { describe, it, expect } from "vitest";
import { isSameProduct } from "../../src/utils/productKey.js";

const product = { _id: "6ac8f66fc3dc8dd84104d8ea", productId: "p4" };

describe("isSameProduct (F1)", () => {
  it("a line saved by productId matches the product (the case that was broken)", () => {
    expect(isSameProduct("p4", product)).toBe(true);
  });
  it("a line saved by _id still matches", () => {
    expect(isSameProduct("6ac8f66fc3dc8dd84104d8ea", product)).toBe(true);
  });
  it("another product does not match", () => {
    expect(isSameProduct("p5", product)).toBe(false);
  });
  it("missing values never match", () => {
    expect(isSameProduct(undefined, product)).toBe(false);
    expect(isSameProduct("p4", null)).toBe(false);
    expect(isSameProduct("", { _id: "x" })).toBe(false);
  });
});
