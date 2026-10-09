import { describe, it, expect } from "vitest";
import {
  ADMIN_STATUS_TRANSITIONS,
  checkStatusChange,
  checkApprove,
  checkReject,
  isPaymentSettled,
} from "../../server/utils/orderStatus.js";

const order = (over = {}) => ({ orderStatus: "processing", approvalStatus: "PENDING", paymentMethod: "cod", paidAt: null, ...over });
const ALL = ["processing", "shipped", "delivered", "cancelled"];

describe("checkStatusChange — the admin status table", () => {
  // Every pair, so a change to the table shows up here.
  const expected = {
    pending: { cancelled: true },
    processing: { shipped: true, delivered: true, cancelled: true },
    shipped: { delivered: true },
    delivered: {},
    cancelled: {},
    expired: {},
  };
  for (const [from, allowed] of Object.entries(expected)) {
    for (const to of ALL) {
      if (from === to) continue;
      it(`${from} → ${to}: ${allowed[to] ? "allowed" : "refused"} (approved order)`, () => {
        const r = checkStatusChange(order({ orderStatus: from, approvalStatus: "APPROVED" }), to);
        expect(r.ok).toBe(Boolean(allowed[to]));
      });
    }
  }

  it("the table is exactly the documented one", () => {
    expect(ADMIN_STATUS_TRANSITIONS).toEqual({
      pending: ["cancelled"],
      processing: ["shipped", "delivered", "cancelled"],
      shipped: ["delivered"],
      delivered: [],
      cancelled: [],
      expired: [],
    });
  });

  it.each(["shipped", "delivered"])("%s needs approval", (to) => {
    expect(checkStatusChange(order(), to)).toEqual({ ok: false, error: "Approve this order before marking it shipped or delivered" });
    expect(checkStatusChange(order({ approvalStatus: "REJECTED" }), to).ok).toBe(false);
  });

  it("cancelling never needs approval", () => {
    expect(checkStatusChange(order(), "cancelled").ok).toBe(true);
  });

  it("setting the status it already has is a no-op, not an error", () => {
    expect(checkStatusChange(order({ orderStatus: "delivered", approvalStatus: "APPROVED" }), "delivered")).toEqual({ ok: true, noop: true });
  });

  it("end states say so", () => {
    expect(checkStatusChange(order({ orderStatus: "expired" }), "processing").error).toMatch(/expired and can no longer be changed/);
  });

  it("an unknown legacy status is refused, not guessed at", () => {
    expect(checkStatusChange(order({ orderStatus: "on-hold" }), "shipped").ok).toBe(false);
  });

  it("missing status is treated as processing; status is case-insensitive", () => {
    expect(checkStatusChange(order({ orderStatus: undefined }), "cancelled").ok).toBe(true);
    expect(checkStatusChange(order({ orderStatus: "Processing" }), "cancelled").ok).toBe(true);
  });
});

describe("checkApprove / checkReject", () => {
  it("COD processing and paid online orders can be approved", () => {
    expect(checkApprove(order()).ok).toBe(true);
    expect(checkApprove(order({ paymentMethod: "razorpay", paidAt: new Date() })).ok).toBe(true);
  });

  it("an unpaid online order cannot be approved (S2d)", () => {
    expect(checkApprove(order({ orderStatus: "pending", paymentMethod: "razorpay" })).error).toMatch(/hasn't been paid/);
  });

  it.each(["expired", "cancelled", "delivered", "shipped"])("a %s order cannot be approved (S7a, B18)", (s) => {
    expect(checkApprove(order({ orderStatus: s })).ok).toBe(false);
  });

  it("a rejected order cannot be approved; an approved one cannot be re-approved (S7e)", () => {
    expect(checkApprove(order({ approvalStatus: "REJECTED" })).ok).toBe(false);
    expect(checkApprove(order({ approvalStatus: "APPROVED" })).ok).toBe(false);
  });

  it("reject: only PENDING decisions on live orders; an unpaid online order can be declined", () => {
    expect(checkReject(order()).ok).toBe(true);
    expect(checkReject(order({ orderStatus: "pending", paymentMethod: "razorpay" })).ok).toBe(true);
    expect(checkReject(order({ approvalStatus: "APPROVED" })).error).toBe("An approved order cannot be rejected");
    expect(checkReject(order({ approvalStatus: "REJECTED" })).ok).toBe(false);
    expect(checkReject(order({ orderStatus: "cancelled" })).ok).toBe(false);
  });

  it("isPaymentSettled: COD (any case, or none recorded) or paidAt", () => {
    expect(isPaymentSettled({ paymentMethod: "COD" })).toBe(true);
    expect(isPaymentSettled({})).toBe(true);
    expect(isPaymentSettled({ paymentMethod: "razorpay" })).toBe(false);
    expect(isPaymentSettled({ paymentMethod: "razorpay", paidAt: new Date() })).toBe(true);
  });
});
