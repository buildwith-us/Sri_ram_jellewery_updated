import { describe, it, expect, vi } from "vitest";
import * as S from "../../server/middleware/validate.js";
import { AUTH_CODES } from "../../shared/authCodes.js";

const parse = (schema, body) => schema.safeParse(body);

describe("validate() middleware", () => {
  it("400s with the first issue and a details list", () => {
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();
    S.validate(S.contactSchema)({ body: { email: "bad" } }, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    const body = res.json.mock.calls[0][0];
    expect(body.error).toBe("Name is required");
    expect(body.details.map((d) => d.field)).toEqual(expect.arrayContaining(["name", "email", "message"]));
    expect(next).not.toHaveBeenCalled();
  });

  it("replaces req.body with the parsed (coerced, stripped) value", () => {
    const req = { body: { quantity: "3", sneaky: true } };
    S.validate(S.updateCartItemSchema)(req, {}, () => {});
    expect(req.body).toEqual({ quantity: 3 });
  });
});

describe("schemas", () => {
  it("cart quantity: 1–99 to add, 0–99 to update, integers only", () => {
    expect(parse(S.addToCartSchema, { productId: "p", quantity: 0 }).success).toBe(false);
    expect(parse(S.addToCartSchema, { productId: "p", quantity: 1 }).success).toBe(true);
    expect(parse(S.addToCartSchema, { productId: "p", quantity: 99 }).success).toBe(true);
    expect(parse(S.addToCartSchema, { productId: "p", quantity: 100 }).success).toBe(false);
    expect(parse(S.addToCartSchema, { productId: "p", quantity: 1.5 }).success).toBe(false);
    expect(parse(S.updateCartItemSchema, { quantity: 0 }).success).toBe(true);
    expect(parse(S.updateCartItemSchema, { quantity: -1 }).success).toBe(false);
    expect(parse(S.updateCartItemSchema, { quantity: 100 }).success).toBe(false);
    expect(parse(S.updateCartItemSchema, {}).success).toBe(false);
  });

  it("createOrderSchema: at least one item, positive integer quantities", () => {
    expect(parse(S.createOrderSchema, { items: [] }).success).toBe(false);
    expect(parse(S.createOrderSchema, { items: [{ productId: "p", quantity: 0 }] }).success).toBe(false);
    expect(parse(S.createOrderSchema, { items: [{ productId: "p", quantity: -2 }] }).success).toBe(false);
    expect(parse(S.createOrderSchema, { items: [{ productId: "p", quantity: 0.5 }] }).success).toBe(false);
    expect(parse(S.createOrderSchema, { items: [{ productId: "p" }] }).success).toBe(true);
  });

  it("createOrderSchema accepts only cash on delivery, in any case (S2)", () => {
    for (const m of ["cod", "COD", " Cod "]) {
      const r = parse(S.createOrderSchema, { items: [{ productId: "p" }], paymentMethod: m });
      expect(r.success).toBe(true);
      expect(r.data.paymentMethod).toBe("cod");
    }
    for (const m of ["razorpay", "upi", "free", "", 0, null]) {
      expect(parse(S.createOrderSchema, { items: [{ productId: "p" }], paymentMethod: m }).success, String(m)).toBe(false);
    }
    // Omitted has always meant COD.
    expect(parse(S.createOrderSchema, { items: [{ productId: "p" }] }).success).toBe(true);
  });

  it("order approval: REJECTED needs a non-blank reason", () => {
    expect(parse(S.orderApprovalSchema, { approvalStatus: "APPROVED" }).success).toBe(true);
    expect(parse(S.orderApprovalSchema, { approvalStatus: "REJECTED" }).success).toBe(false);
    expect(parse(S.orderApprovalSchema, { approvalStatus: "REJECTED", rejectionReason: "   " }).success).toBe(false);
    expect(parse(S.orderApprovalSchema, { approvalStatus: "REJECTED", rejectionReason: "x" }).success).toBe(true);
    expect(parse(S.orderApprovalSchema, { approvalStatus: "PENDING" }).success).toBe(false);
  });

  it("order status: only the four admin-settable statuses", () => {
    for (const s of ["processing", "shipped", "delivered", "cancelled"]) {
      expect(parse(S.orderStatusSchema, { status: s }).success).toBe(true);
    }
    expect(parse(S.orderStatusSchema, { status: "expired" }).success).toBe(false);
    expect(parse(S.orderStatusSchema, { status: "pending" }).success).toBe(false);
  });

  it("product: percents 0–100, numeric strings coerced", () => {
    const r = parse(S.createProductSchema, { name: "n", category: "c", weight: "4.5", gstPercent: "3" });
    expect(r.data).toMatchObject({ weight: 4.5, gstPercent: 3 });
    expect(parse(S.createProductSchema, { name: "n", category: "c", wastagePercent: 101 }).success).toBe(false);
    expect(parse(S.createProductSchema, { name: "n", category: "c", metalType: "platinum" }).success).toBe(false);
  });

  it("product: z.coerce.boolean turns the string 'false' into true (see bug report)", () => {
    const r = parse(S.createProductSchema, { name: "n", category: "c", isQuoteOnly: "false" });
    expect(r.data.isQuoteOnly).toBe(true);
  });

  it("product: negative weight and stock are accepted (see bug report)", () => {
    expect(parse(S.createProductSchema, { name: "n", category: "c", weight: -5, stock: -3 }).success).toBe(true);
  });

  it("shipping address: 6-digit PIN, 10–15 char mobile, email required", () => {
    const good = {
      firstName: "A", email: "a@b.co", streetAddress: "s", city: "c", state: "s",
      postalCode: "625001", mobileNumber: "9876543210",
    };
    expect(parse(S.shippingAddressSchema, good).success).toBe(true);
    expect(parse(S.shippingAddressSchema, { ...good, postalCode: "62500" }).success).toBe(false);
    expect(parse(S.shippingAddressSchema, { ...good, mobileNumber: "12345" }).success).toBe(false);
    expect(parse(S.shippingAddressSchema, { ...good, email: undefined }).success).toBe(false);
  });

  it("profile update strips role / passwordHash", () => {
    const r = parse(S.updateProfileSchema, { name: "x", role: "ADMIN", passwordHash: "h" });
    expect(r.data).toEqual({ name: "x" });
  });

  it("review rating 1–5; review text ≤ 2000", () => {
    expect(parse(S.createReviewSchema, { review: "r", rating: 0 }).success).toBe(false);
    expect(parse(S.createReviewSchema, { review: "r", rating: 6 }).success).toBe(false);
    expect(parse(S.createReviewSchema, { review: "r", rating: "4" }).success).toBe(true);
    expect(parse(S.createReviewSchema, { review: "x".repeat(2001), rating: 4 }).success).toBe(false);
  });

  it("trackView sessionId ≤ 64 chars", () => {
    expect(parse(S.trackViewSchema, { sessionId: "x".repeat(64) }).success).toBe(true);
    expect(parse(S.trackViewSchema, { sessionId: "x".repeat(65) }).success).toBe(false);
  });

  it("missing required fields give the friendly message, not zod's default", () => {
    expect(parse(S.contactSchema, {}).error.issues[0].message).toBe("Name is required");
    expect(parse(S.quoteRequestSchema, {}).error.issues[0].message).toBe("Product ID is required");
  });
});

describe("shared/authCodes", () => {
  it("exposes the exact strings the client interceptor keys on", () => {
    expect(AUTH_CODES).toEqual({
      TOKEN_EXPIRED: "TOKEN_EXPIRED",
      TOKEN_INVALID: "TOKEN_INVALID",
      TOKEN_MISSING: "TOKEN_MISSING",
      FORBIDDEN_ROLE: "FORBIDDEN_ROLE",
      AUTH_UNCONFIGURED: "AUTH_UNCONFIGURED",
    });
  });
});
