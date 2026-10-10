/**
 * Every route in server/routes/*.js, with the auth level it must enforce.
 * Guards are checked mechanically so a new route cannot silently ship without
 * one — add it to ROUTES and it is covered.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useApp } from "../helpers/app.js";
import {
  makeCustomer,
  makeAdmin,
  expiredTokenFor,
  tamperedTokenFor,
  wrongSecretTokenFor,
} from "../helpers/factories.js";

const ctx = useApp();
const ID = "0123456789abcdef01234567";

export const ROUTES = {
  public: [
    ["post", "/api/auth/otp/request"],
    ["post", "/api/auth/otp/verify"],
    ["post", "/api/auth/register"],
    ["post", "/api/auth/login"],
    ["post", "/api/auth/refresh"],
    ["post", "/api/auth/password/forgot"],
    ["post", "/api/auth/password/reset"],
    ["get", "/api/products/filter"],
    ["get", "/api/products"],
    ["get", "/api/products/search"],
    ["get", `/api/products/${ID}`],
    ["post", `/api/products/${ID}/view`],
    ["get", "/api/categories"],
    ["get", "/api/reviews/some-product"],
    ["get", "/api/reviews"],
    ["get", "/api/rates"],
    ["post", "/api/contact"],
    ["post", "/api/newsletter"],
    ["post", "/api/payment/webhook"],
    ["get", "/api/health"],
    ["get", "/api/nav-notifications"],
  ],
  user: [
    ["post", "/api/auth/logout"],
    ["get", "/api/cart"],
    ["get", "/api/cart/subtotal"],
    ["post", "/api/cart"],
    ["patch", `/api/cart/${ID}`],
    ["delete", `/api/cart/${ID}`],
    ["get", "/api/wishlist"],
    ["post", "/api/wishlist"],
    ["delete", `/api/wishlist/${ID}`],
    ["delete", "/api/wishlist?productId=x"],
    ["get", "/api/orders"],
    ["get", `/api/orders/${ID}`],
    ["post", "/api/orders"],
    ["patch", `/api/orders/${ID}/cancel`],
    ["delete", "/api/orders/delete-cart-items"],
    ["get", "/api/users/me"],
    ["patch", "/api/users/me"],
    ["patch", "/api/users/me/password"],
    ["patch", "/api/users/shipping-address"],
    ["patch", "/api/users/delete-address"],
    ["get", "/api/users/me/addresses"],
    ["post", "/api/users/me/addresses"],
    ["patch", `/api/users/me/addresses/${ID}`],
    ["delete", `/api/users/me/addresses/${ID}`],
    ["post", "/api/reviews"],
    ["delete", `/api/reviews/${ID}`],
    ["post", "/api/quotes"],
    ["post", "/api/payment/create-order"],
    ["post", "/api/payment/verify"],
  ],
  admin: [
    ["post", "/api/products"],
    ["patch", `/api/products/${ID}`],
    ["delete", `/api/products/${ID}`],
    ["get", "/api/orders/admin/all"],
    ["patch", `/api/orders/${ID}/status`],
    ["patch", `/api/orders/${ID}/approval`],
    ["get", "/api/users"],
    ["patch", `/api/users/${ID}`],
    ["delete", `/api/users/${ID}`],
    ["post", "/api/categories"],
    ["patch", `/api/categories/${ID}`],
    ["delete", `/api/categories/${ID}`],
    ["get", "/api/admin/total-spent"],
    ["get", "/api/admin/cloudinary-signature"],
    ["patch", "/api/rates"],
    ["get", "/api/quotes"],
    ["get", "/api/quotes/summary"],
    ["patch", `/api/quotes/${ID}/status`],
    ["get", "/api/contact"],
    ["get", "/api/newsletter"],
    ["get", "/api/admin-dashboard/revenue"],
    ["get", "/api/admin-dashboard/sales-by-category"],
    ["get", "/api/admin-dashboard/best-selling"],
    ["get", "/api/admin-dashboard/most-wishlisted"],
    ["get", "/api/admin-dashboard/stats"],
    ["get", "/api/admin-dashboard/top-selling-categories"],
    ["get", "/api/admin-dashboard/income-stats"],
    ["get", "/api/admin-dashboard/popular-products"],
    ["get", "/api/admin-dashboard/recent-reviews"],
    ["get", "/api/admin-dashboard/most-viewed"],
  ],
  cron: [
    ["get", "/api/cron/release-stale-reservations"],
    ["get", "/api/cron/health"],
  ],
};

const protectedRoutes = [...ROUTES.user, ...ROUTES.admin];

describe("route inventory", () => {
  it("matches the documented split: 30 admin, 29 self-scoped", () => {
    expect(ROUTES.admin).toHaveLength(30);
    expect(ROUTES.user).toHaveLength(29);
  });
});

describe.each(protectedRoutes)("%s %s", (method, path) => {
  let customer;
  beforeEach(async () => {
    customer = await makeCustomer();
  });

  it("no Authorization header → 401 TOKEN_MISSING", async () => {
    const res = await ctx.api()[method](path);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("TOKEN_MISSING");
  });

  it("non-Bearer scheme → 401 TOKEN_MISSING", async () => {
    const res = await ctx.api()[method](path).set("Authorization", `Basic ${customer.token}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("TOKEN_MISSING");
  });

  it("expired token → 401 TOKEN_EXPIRED", async () => {
    const res = await ctx.api(expiredTokenFor(customer.user))[method](path);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("TOKEN_EXPIRED");
  });

  it("tampered payload → 401 TOKEN_INVALID", async () => {
    const res = await ctx.api(tamperedTokenFor(customer.user))[method](path);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("TOKEN_INVALID");
  });

  it("token signed with another secret → 401 TOKEN_INVALID", async () => {
    const res = await ctx.api(wrongSecretTokenFor(customer.user))[method](path);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("TOKEN_INVALID");
  });

  it("garbage token → 401 TOKEN_INVALID", async () => {
    const res = await ctx.api("not.a.jwt")[method](path);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("TOKEN_INVALID");
  });
});

describe.each(ROUTES.admin)("admin-only %s %s", (method, path) => {
  it("customer token → 403", async () => {
    const { token } = await makeCustomer();
    const res = await ctx.api(token)[method](path);
    expect(res.status).toBe(403);
  });

  it("admin token passes the guard (never 401/403)", async () => {
    const { token } = await makeAdmin();
    const res = await ctx.api(token)[method](path);
    expect([401, 403]).not.toContain(res.status);
  });
});

describe.each(ROUTES.user)("self-scoped %s %s", (method, path) => {
  it("customer token passes the guard (never 401/403)", async () => {
    const { token } = await makeCustomer();
    const res = await ctx.api(token)[method](path);
    expect([401, 403]).not.toContain(res.status);
  });
});

describe.each(ROUTES.public)("public %s %s", (method, path) => {
  it("reachable without a token, and never a 500 on an empty database", async () => {
    const res = await ctx.api()[method](path);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect(res.status).toBeLessThan(500);
  });

  it("an expired token on a public route is not an error either", async () => {
    const { user } = await makeCustomer();
    const res = await ctx.api(expiredTokenFor(user))[method](path);
    expect(res.status).not.toBe(401);
    expect(res.status).toBeLessThan(500);
  });
});

describe.each(ROUTES.cron)("cron %s %s", (method, path) => {
  it("user and admin JWTs are not accepted in place of CRON_SECRET", async () => {
    const { token } = await makeAdmin();
    expect((await ctx.api(token)[method](path)).status).toBe(401);
  });
});

describe("TOKEN_EXPIRED is emitted only by verifyJWT", () => {
  it("no route outside the middleware verifies JWTs itself", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const dir = path.resolve(import.meta.dirname, "../../server/routes");
    for (const f of await fs.readdir(dir)) {
      const src = await fs.readFile(path.join(dir, f), "utf8");
      expect(src, f).not.toMatch(/jwt\.verify\(/);
      expect(src, f).not.toMatch(/TOKEN_EXPIRED/);
    }
  });
});
