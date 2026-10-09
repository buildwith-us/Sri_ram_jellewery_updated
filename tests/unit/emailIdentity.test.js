import { describe, it, expect } from "vitest";
import { normalizeEmail, canonicalEmailKey } from "../../server/utils/emailIdentity.js";

describe("normalizeEmail — one key per mailbox", () => {
  it.each([
    ["asha.raman@gmail.com"],
    ["AshaRaman@gmail.com"],
    ["  asharaman@GMAIL.COM  "],
    ["asha.raman+offers@gmail.com"],
    ["a.s.h.a.r.a.m.a.n+x+y@gmail.com"],
    ["AshaRaman@googlemail.com"],
    ["asha.raman+shop@GoogleMail.com"],
  ])("%j → asharaman@gmail.com", (input) => {
    expect(normalizeEmail(input)).toMatchObject({ ok: true, key: "asharaman@gmail.com" });
  });

  it("keeps the address as typed (trimmed) for display", () => {
    expect(normalizeEmail("  Asha.Raman+Shop@Gmail.com ")).toEqual({
      ok: true,
      key: "asharaman@gmail.com",
      display: "Asha.Raman+Shop@Gmail.com",
    });
  });

  it("other providers: lowercased and trimmed, but dots and +tags are significant", () => {
    expect(normalizeEmail(" A.B@Shop.IN ").key).toBe("a.b@shop.in");
    expect(normalizeEmail("ab@shop.in").key).toBe("ab@shop.in");
    expect(normalizeEmail("ab+orders@shop.in").key).toBe("ab+orders@shop.in");
    expect(normalizeEmail("first.last@outlook.com").key).toBe("first.last@outlook.com");
  });

  it("a subdomain of gmail is not gmail", () => {
    expect(normalizeEmail("a.b@mail.gmail.com").key).toBe("a.b@mail.gmail.com");
  });

  it.each([
    [undefined, "Email address is required"],
    [null, "Email address is required"],
    ["", "Email address is required"],
    ["   ", "Email address is required"],
    ["plainaddress", "Enter a valid email address"],
    ["no-tld@shop", "Enter a valid email address"],
    ["two@@shop.in", "Enter a valid email address"],
    ["spaces in@shop.in", "Enter a valid email address"],
    ["+only@gmail.com", "Enter a valid email address"],
    [12345, "Enter a valid email address"],
    [{ email: "a@b.co" }, "Enter a valid email address"],
    [["a@b.co"], "Enter a valid email address"],
    ["x".repeat(250) + "@a.in", "Enter a valid email address"],
  ])("%j → refused (%s)", (input, reason) => {
    expect(normalizeEmail(input)).toEqual({ ok: false, reason });
  });
});

describe("canonicalEmailKey — comparing stored addresses", () => {
  it("applies the same rules without validating (the seeded admin has no TLD)", () => {
    expect(canonicalEmailKey("Admin@BuildWithUs")).toBe("admin@buildwithus");
    expect(canonicalEmailKey("Owner.Name+x@googlemail.com")).toBe("ownername@gmail.com");
  });

  it("agrees with normalizeEmail for every valid address", () => {
    for (const s of ["A.B+c@gmail.com", "x@shop.in", " Y.Z@GoogleMail.com "]) {
      expect(canonicalEmailKey(s)).toBe(normalizeEmail(s).key);
    }
  });

  it.each([[null], [undefined], [42], ["no-at-sign"], ["@shop.in"], ["name@"], ["+@gmail.com"]])("%j → null", (input) => {
    expect(canonicalEmailKey(input)).toBeNull();
  });
});
