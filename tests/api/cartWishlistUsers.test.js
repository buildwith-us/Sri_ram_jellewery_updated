import { describe, it, expect } from "vitest";
import { useApp } from "../helpers/app.js";
import { seedCatalog, makeCustomer, makeAdmin, uniquePhone, customerViaOtp, SHIPPING } from "../helpers/factories.js";
import { Cart } from "../../server/models/Cart.js";
import { Wishlist } from "../../server/models/Wishlist.js";
import { User } from "../../server/models/User.js";

const ctx = useApp();

// ─── Cart ────────────────────────────────────────────────────────────────────

describe("cart", () => {
  const add = (token, body) => ctx.api(token).post("/api/cart").send({ name: "Item", ...body });

  it("add, then GET shows the live price (not the client's) and gstPercent", async () => {
    await seedCatalog();
    const c = await makeCustomer();
    expect((await add(c.token, { productId: "gold-ring", price: 1, quantity: 2 })).body).toEqual({ insertedId: "gold-ring", success: true });
    const res = await ctx.api(c.token).get("/api/cart");
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ productId: "gold-ring", price: 80752, quantity: 2, gstPercent: 3 });
  });

  it("adding the same product again increments quantity (no duplicate rows)", async () => {
    await seedCatalog();
    const c = await makeCustomer();
    await add(c.token, { productId: "gold-ring", quantity: 1 });
    await add(c.token, { productId: "gold-ring", quantity: 2 });
    const rows = await Cart.find({ userId: String(c.user._id) }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBe(3);
  });

  it("subtotal is GST-inclusive with GST itemised", async () => {
    await seedCatalog();
    const c = await makeCustomer();
    await add(c.token, { productId: "gold-ring", quantity: 2 });
    await add(c.token, { productId: "gift-box", quantity: 1 });
    const res = await ctx.api(c.token).get("/api/cart/subtotal");
    expect(res.body).toEqual({
      subtotal: (80752 * 2 + 1500).toFixed(2),
      gstAmount: (2352 * 2).toFixed(2),
      subtotalExGst: (78400 * 2 + 1500).toFixed(2),
      totalItems: 2,
    });
  });

  it("empty cart: [] and zero subtotal", async () => {
    const c = await makeCustomer();
    expect((await ctx.api(c.token).get("/api/cart")).body).toEqual([]);
    expect((await ctx.api(c.token).get("/api/cart/subtotal")).body).toEqual({ subtotal: "0.00", gstAmount: "0.00", subtotalExGst: "0.00", totalItems: 0 });
  });

  it.each([[0], [100], [-1], [1.5], ["abc"]])("add quantity %s → 400", async (quantity) => {
    const c = await makeCustomer();
    expect((await add(c.token, { productId: "gold-ring", quantity })).status).toBe(400);
  });

  it("add without productId → 400", async () => {
    const c = await makeCustomer();
    expect((await add(c.token, {})).status).toBe(400);
  });

  it("PATCH quantity 1–99 by row _id or productId; 0 removes the row", async () => {
    await seedCatalog();
    const c = await makeCustomer();
    await add(c.token, { productId: "gold-ring" });
    const row = await Cart.findOne({}).lean();
    expect((await ctx.api(c.token).patch(`/api/cart/${row._id}`).send({ quantity: 99 })).body.data.quantity).toBe(99);
    expect((await ctx.api(c.token).patch("/api/cart/gold-ring").send({ quantity: 5 })).body.data.quantity).toBe(5);
    const removed = await ctx.api(c.token).patch("/api/cart/gold-ring").send({ quantity: 0 });
    expect(removed.body.message).toMatch(/removed/);
    expect(await Cart.countDocuments()).toBe(0);
  });

  it.each([[100], [-1], [undefined]])("PATCH quantity %s → 400", async (quantity) => {
    const c = await makeCustomer();
    expect((await ctx.api(c.token).patch("/api/cart/gold-ring").send({ quantity })).status).toBe(400);
  });

  it("another user's cart row: PATCH 404, DELETE deletes nothing", async () => {
    await seedCatalog();
    const owner = await makeCustomer();
    const other = await makeCustomer();
    await add(owner.token, { productId: "gold-ring" });
    const row = await Cart.findOne({}).lean();
    expect((await ctx.api(other.token).patch(`/api/cart/${row._id}`).send({ quantity: 3 })).status).toBe(404);
    expect((await ctx.api(other.token).delete(`/api/cart/${row._id}`)).body.deletedCount).toBe(0);
    expect(await Cart.countDocuments()).toBe(1);
  });

  it("DELETE by row _id or productId", async () => {
    const c = await makeCustomer();
    await add(c.token, { productId: "a" });
    await add(c.token, { productId: "b" });
    const a = await Cart.findOne({ productId: "a" }).lean();
    expect((await ctx.api(c.token).delete(`/api/cart/${a._id}`)).body.deletedCount).toBe(1);
    expect((await ctx.api(c.token).delete("/api/cart/b")).body.deletedCount).toBe(1);
  });
});

// ─── Wishlist ────────────────────────────────────────────────────────────────

describe("wishlist", () => {
  const add = (token, body) => ctx.api(token).post("/api/wishlist").send({ name: "Item", ...body });

  it("add is idempotent per product; GET is scoped to the caller", async () => {
    const a = await makeCustomer();
    const b = await makeCustomer();
    await add(a.token, { productId: "gold-ring" });
    await add(a.token, { productId: "gold-ring" });
    await add(b.token, { productId: "gold-ring" });
    const res = await ctx.api(a.token).get("/api/wishlist");
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ productId: "gold-ring", img: "/logo.png", category: "Jewellery" });
  });

  it("remove by row _id, by productId and by ?productId=", async () => {
    const c = await makeCustomer();
    await add(c.token, { productId: "a" });
    await add(c.token, { productId: "b" });
    await add(c.token, { productId: "c" });
    const a = await Wishlist.findOne({ productId: "a" }).lean();
    expect((await ctx.api(c.token).delete(`/api/wishlist/${a._id}`)).body.deletedCount).toBe(1);
    expect((await ctx.api(c.token).delete("/api/wishlist/b")).body.deletedCount).toBe(1);
    expect((await ctx.api(c.token).delete("/api/wishlist?productId=c")).body.deletedCount).toBe(1);
    expect((await ctx.api(c.token).delete("/api/wishlist")).status).toBe(400);
  });

  it("cannot remove another user's row", async () => {
    const owner = await makeCustomer();
    const other = await makeCustomer();
    await add(owner.token, { productId: "a" });
    const row = await Wishlist.findOne({}).lean();
    expect((await ctx.api(other.token).delete(`/api/wishlist/${row._id}`)).body.deletedCount).toBe(0);
    expect(await Wishlist.countDocuments()).toBe(1);
  });

  it("without productId → 400", async () => {
    const c = await makeCustomer();
    expect((await add(c.token, {})).status).toBe(400);
  });
});

// ─── Users ───────────────────────────────────────────────────────────────────

describe("users — self service", () => {
  it("GET /me hides passwordHash and adds the derived admin flag", async () => {
    const { token } = await makeAdmin();
    const res = await ctx.api(token).get("/api/users/me");
    expect(res.status).toBe(200);
    expect(res.body.data.passwordHash).toBeUndefined();
    expect(res.body.data.admin).toBe(true);
  });

  it("PATCH /me updates name/photo, normalises phone, ignores role", async () => {
    const c = await makeCustomer();
    const phone = uniquePhone();
    const res = await ctx.api(c.token).patch("/api/users/me").send({ name: "New Name", phone: `0${phone}`, role: "ADMIN" });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: "New Name", phone: `+91${phone}`, role: "USER" });
  });

  it("PATCH /me: email is the sign-in identity — any change, including clearing it, is refused", async () => {
    const c = await makeCustomer();
    for (const email of ["new@example.com", "", c.user.email.toUpperCase()]) {
      const res = await ctx.api(c.token).patch("/api/users/me").send({ email });
      expect(res.status, JSON.stringify(email)).toBe(400);
      expect(res.body.error).toMatch(/contact the shop/);
    }
    const after = await User.findById(c.user._id).lean();
    expect(after.email).toBe(c.user.email);
    expect(after.emailKey).toBe(c.user.emailKey);
  });

  it("PATCH /me: emailKey and role in the body are ignored (identity fields are not writable)", async () => {
    const c = await makeCustomer();
    const res = await ctx.api(c.token).patch("/api/users/me").send({ name: "Still Me", emailKey: "victim@example.com", role: "ADMIN" });
    expect(res.status).toBe(200);
    const after = await User.findById(c.user._id).lean();
    expect(after).toMatchObject({ name: "Still Me", emailKey: c.user.emailKey, role: "USER" });
  });

  it("PATCH /me: someone else's phone → 409", async () => {
    const a = await makeCustomer();
    const b = await makeCustomer();
    expect((await ctx.api(b.token).patch("/api/users/me").send({ phone: a.user.phone })).status).toBe(409);
    // Same number in another spelling is the same number.
    const national = a.user.phone.replace("+91", "");
    expect((await ctx.api(b.token).patch("/api/users/me").send({ phone: `0${national}` })).status).toBe(409);
  });

  it("registration: a new email-code customer adds name + phone and the profile becomes complete", async () => {
    const s = await customerViaOtp(ctx.api);
    expect(s.profileComplete).toBe(false);
    const phone = uniquePhone();
    const res = await ctx.api(s.token).patch("/api/users/me").send({ name: "  Asha Raman  ", phone: `+91 ${phone}` });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: "Asha Raman", phone: `+91${phone}`, profileComplete: true, missing: [] });
    expect((await ctx.api(s.token).get("/api/users/me")).body.data.profileComplete).toBe(true);
  });

  it("registration: the phone cannot be cleared once set", async () => {
    const c = await makeCustomer();
    expect((await ctx.api(c.token).patch("/api/users/me").send({ phone: "" })).status).toBe(400);
    expect((await User.findById(c.user._id).lean()).phone).toBe(c.user.phone);
  });

  it("PATCH /me invalid phone or any email → 400", async () => {
    const c = await makeCustomer();
    expect((await ctx.api(c.token).patch("/api/users/me").send({ phone: "123" })).status).toBe(400);
    expect((await ctx.api(c.token).patch("/api/users/me").send({ phone: "5123456789" })).status).toBe(400);
    expect((await ctx.api(c.token).patch("/api/users/me").send({ email: "nope" })).status).toBe(400);
  });

  it("shipping address: save all form fields, then delete", async () => {
    const c = await makeCustomer();
    const res = await ctx.api(c.token).patch("/api/users/shipping-address").send(SHIPPING);
    expect(res.status).toBe(200);
    expect((await User.findById(c.user._id).lean()).shippingAddress).toEqual(SHIPPING);
    await ctx.api(c.token).patch("/api/users/delete-address");
    expect((await User.findById(c.user._id).lean()).shippingAddress).toBeUndefined();
  });

  it.each([
    [{ postalCode: "12345" }, /6-digit PIN/],
    [{ mobileNumber: "123" }, /mobile/],
    [{ email: "x" }, /email/],
    [{ firstName: "" }, /First name/],
  ])("shipping address validation %j → 400", async (patch, msg) => {
    const c = await makeCustomer();
    const res = await ctx.api(c.token).patch("/api/users/shipping-address").send({ ...SHIPPING, ...patch });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(msg);
  });

  it("address book CRUD: first address becomes default; others unset on a new default", async () => {
    const c = await makeCustomer();
    const a = await ctx.api(c.token).post("/api/users/me/addresses").send({ label: "Home", city: "Madurai" });
    expect(a.status).toBe(201);
    expect(a.body.data.isDefault).toBe(true);
    const b = await ctx.api(c.token).post("/api/users/me/addresses").send({ label: "Work", city: "Chennai", isDefault: true });
    const list = (await ctx.api(c.token).get("/api/users/me/addresses")).body.data;
    expect(list.find((x) => x.label === "Home").isDefault).toBe(false);
    const upd = await ctx.api(c.token).patch(`/api/users/me/addresses/${a.body.data._id}`).send({ city: "Trichy" });
    expect(upd.body.data.city).toBe("Trichy");
    expect((await ctx.api(c.token).delete(`/api/users/me/addresses/${b.body.data._id}`)).status).toBe(200);
    expect((await ctx.api(c.token).delete(`/api/users/me/addresses/${b.body.data._id}`)).status).toBe(404);
  });

  it("address of another user → 404", async () => {
    const owner = await makeCustomer();
    const other = await makeCustomer();
    const a = await ctx.api(owner.token).post("/api/users/me/addresses").send({ label: "Home" });
    expect((await ctx.api(other.token).patch(`/api/users/me/addresses/${a.body.data._id}`).send({ city: "x" })).status).toBe(404);
    expect((await ctx.api(other.token).delete(`/api/users/me/addresses/${a.body.data._id}`)).status).toBe(404);
  });

  it("a token for a deleted user: /me → 404", async () => {
    const c = await makeCustomer();
    await User.deleteMany({});
    expect((await ctx.api(c.token).get("/api/users/me")).status).toBe(404);
    expect((await ctx.api(c.token).patch("/api/users/me").send({ name: "x" })).status).toBe(404);
    expect((await ctx.api(c.token).patch("/api/users/shipping-address").send(SHIPPING)).status).toBe(404);
    expect((await ctx.api(c.token).get("/api/users/me/addresses")).status).toBe(404);
  });
});

describe("users — admin management", () => {
  it("GET /api/users lists users without password hashes", async () => {
    const admin = await makeAdmin();
    await makeCustomer();
    const res = await ctx.api(admin.token).get("/api/users");
    expect(res.body).toHaveLength(2);
    for (const u of res.body) expect(u.passwordHash).toBeUndefined();
  });

  it("promote a customer to ADMIN (the Make Admin button)", async () => {
    const admin = await makeAdmin();
    const c = await makeCustomer();
    const res = await ctx.api(admin.token).patch(`/api/users/${c.user._id}`).send({ role: "ADMIN" });
    expect(res.body.data.role).toBe("ADMIN");
  });

  it("delete a user; unknown → 404", async () => {
    const admin = await makeAdmin();
    const c = await makeCustomer();
    expect((await ctx.api(admin.token).delete(`/api/users/${c.user._id}`)).status).toBe(200);
    expect((await ctx.api(admin.token).delete(`/api/users/${c.user._id}`)).status).toBe(404);
    expect((await ctx.api(admin.token).patch(`/api/users/${c.user._id}`).send({ name: "x" })).status).toBe(404);
  });
});
