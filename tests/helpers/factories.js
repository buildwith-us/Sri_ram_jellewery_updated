import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import { GoldRate } from "../../server/models/GoldRate.js";
import { Product } from "../../server/models/Product.js";
import { User } from "../../server/models/User.js";
import { Order } from "../../server/models/Order.js";
import { canonicalEmailKey } from "../../server/utils/emailIdentity.js";

export const RATES = { gold: 7000, silver: 90 };
const DAY = 24 * 60 * 60 * 1000;

// ─── Rates ───────────────────────────────────────────────────────────────────

export const seedRates = async ({
  gold = RATES.gold,
  silver = RATES.silver,
  goldUpdatedAt = new Date(),
  silverUpdatedAt = new Date(),
} = {}) => {
  const docs = [];
  if (gold !== null) docs.push({ metalType: "gold", ratePerGram: gold, updatedAt: goldUpdatedAt });
  if (silver !== null) docs.push({ metalType: "silver", ratePerGram: silver, updatedAt: silverUpdatedAt });
  await GoldRate.insertMany(docs);
};

export const daysAgo = (n) => new Date(Date.now() - n * DAY);

// ─── Products ────────────────────────────────────────────────────────────────
//
// Expected prices are worked out by hand from the formula in ARCHITECTURE.md,
// not by calling computePrice — a test that derives its expectation from the
// code under test cannot catch that code being wrong.

export const PRODUCT_DEFS = {
  // 10g × 7000 = 70,000 metal; 12% wastage = 8,400; subtotal 78,400;
  // GST 3% = 2,352; final 80,752.
  gold: {
    productId: "gold-ring",
    name: "Gold Ring",
    category: "Gold",
    metalType: "gold",
    weight: 10,
    wastagePercent: 12,
    gstPercent: 3,
    price: 999, // making charge — must never be what the customer pays
    stock: 5,
    expected: 80752,
  },
  // 50g × 90 = 4,500; 10% = 450; subtotal 4,950; GST 3% = 148.5; final 5,098.5 → 5,099.
  silver: {
    productId: "silver-anklet",
    name: "Silver Anklet",
    category: "Silver",
    metalType: "silver",
    weight: 50,
    wastagePercent: 10,
    gstPercent: 3,
    price: 250,
    stock: 5,
    expected: 5099,
  },
  quote: {
    productId: "diamond-set",
    name: "Diamond Set",
    category: "Diamond",
    metalType: "gold",
    weight: 20,
    isQuoteOnly: true,
    stock: 3,
    expected: undefined,
  },
  // No weight → stored price stands.
  weightless: {
    productId: "gift-box",
    name: "Gift Box",
    category: "Accessories",
    metalType: "gold",
    weight: 0,
    price: 1500,
    stock: 5,
    expected: 1500,
  },
  // 2g × 7000 = 14,000; no wastage; GST 3% = 420; final 14,420.
  single: {
    productId: "one-of-a-kind",
    name: "One Of A Kind Pendant",
    category: "Gold",
    metalType: "gold",
    weight: 2,
    wastagePercent: 0,
    gstPercent: 3,
    stock: 1,
    expected: 14420,
  },
};

export const createProduct = async (key, overrides = {}) => {
  const { expected, ...def } = PRODUCT_DEFS[key] || {};
  const doc = await Product.create({ ...def, ...overrides });
  return doc.toObject();
};

/** All five catalogue fixtures plus fresh rates. */
export const seedCatalog = async (rateOverrides) => {
  await seedRates(rateOverrides);
  const out = {};
  for (const key of Object.keys(PRODUCT_DEFS)) out[key] = await createProduct(key);
  return out;
};

export const stockOf = async (productId) => (await Product.findOne({ productId }).lean())?.stock;

// ─── Users & tokens ──────────────────────────────────────────────────────────

let phoneCounter = 0;
/** Ten-digit Indian mobile, unique within this process. */
export const uniquePhone = () => {
  phoneCounter += 1;
  const tail = String((process.pid * 7919 + phoneCounter * 104729) % 1_000_000_000).padStart(9, "0");
  return `9${tail}`;
};

const secret = () => process.env.JWT_SECRET;

/** Same claims generateAccessToken() puts in a real token. */
export const tokenFor = (user, opts = {}) =>
  jwt.sign(
    {
      userId: String(user._id),
      role: user.role,
      email: user.email || null,
      phone: user.phone || null,
      name: user.name || null,
    },
    secret(),
    { expiresIn: "30m", ...opts }
  );

export const expiredTokenFor = (user) =>
  jwt.sign(
    { userId: String(user._id), role: user.role, exp: Math.floor(Date.now() / 1000) - 60 },
    secret()
  );

/** Valid signature, then the payload is swapped for one claiming ADMIN. */
export const tamperedTokenFor = (user) => {
  const [header, , sig] = tokenFor(user).split(".");
  const forged = Buffer.from(
    JSON.stringify({ userId: String(user._id), role: "ADMIN", iat: Math.floor(Date.now() / 1000) })
  ).toString("base64url");
  return `${header}.${forged}.${sig}`;
};

export const wrongSecretTokenFor = (user) =>
  jwt.sign({ userId: String(user._id), role: "ADMIN" }, "not-the-server-secret", { expiresIn: "30m" });

let emailCounter = 0;
/** A sign-in address unique within this process. */
export const uniqueEmail = (prefix = "shopper") => `${prefix}.${process.pid}.${++emailCounter}@example.com`;

/** A complete customer (signed in by email code, profile filled in). */
export const makeCustomer = async (overrides = {}) => {
  const email = overrides.email ?? uniqueEmail();
  const user = await User.create({
    email,
    emailKey: canonicalEmailKey(email),
    phone: `+91${uniquePhone()}`,
    name: "Test Customer",
    role: "USER",
    ...overrides,
  });
  return { user: user.toObject(), token: tokenFor(user) };
};

export const ADMIN_PASSWORD = "Correct-Horse-Battery-9";

export const makeAdmin = async (overrides = {}) => {
  const user = await User.create({
    name: "Shop Owner",
    email: `owner${phoneCounter++}@shop.test`,
    // Low cost factor keeps the suite quick; bcrypt.compare reads the cost
    // from the hash, so login still verifies it properly.
    passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 4),
    role: "ADMIN",
    ...overrides,
  });
  return { user: user.toObject(), token: tokenFor(user), password: ADMIN_PASSWORD };
};

/** The sign-in code in the most recent email sent to `to` (Resend is mocked). */
export const lastCodeSentTo = (to) => {
  const calls = globalThis.__mocks.resendSend.mock.calls.filter(([m]) => [].concat(m.to).includes(to));
  const text = calls.at(-1)?.[0]?.text || "";
  return text.match(/sign-in code is (\d{6})/)?.[1] ?? null;
};

/** A customer signed in through the real email-code endpoints. */
export const customerViaOtp = async (api, email = uniqueEmail()) => {
  const r1 = await api().post("/api/auth/otp/request").send({ email });
  if (r1.status !== 200) throw new Error(`otp/request ${r1.status}: ${JSON.stringify(r1.body)}`);
  const otp = lastCodeSentTo(email);
  if (!otp) throw new Error(`no sign-in code was emailed to ${email}`);
  const r2 = await api().post("/api/auth/otp/verify").send({ email, otp });
  if (r2.status !== 200) throw new Error(`otp/verify ${r2.status}: ${JSON.stringify(r2.body)}`);
  return { email, ...r2.body, token: r2.body.accessToken };
};

// ─── Orders ──────────────────────────────────────────────────────────────────

let orderCounter = 0;
/** Insert an order directly, for lifecycle tests that should not depend on
 *  the creation route. */
export const insertOrder = async (overrides = {}) =>
  (
    await Order.create({
      orderId: `ORD-TEST-${process.pid}-${++orderCounter}`,
      userId: "000000000000000000000000",
      items: [{ productId: "gold-ring", name: "Gold Ring", quantity: 1, unitPrice: 80752, metalType: "gold", category: "Gold" }],
      totalAmount: 80752,
      paymentMethod: "cod",
      paymentStatus: "unpaid",
      orderStatus: "processing",
      stockReserved: true,
      ...overrides,
    })
  ).toObject();

export const SHIPPING = {
  firstName: "Asha",
  lastName: "Raman",
  email: "asha@example.test",
  streetAddress: "12 Temple Street",
  city: "Madurai",
  state: "Tamil Nadu",
  postalCode: "625001",
  mobileNumber: "9876543210",
  number: "+91 9876543210",
  country: "India",
};

// ─── Razorpay ────────────────────────────────────────────────────────────────

export const razorpaySignature = (orderId, paymentId) =>
  crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");

export const webhookPayload = (orderId, paymentId = `pay_${Math.random().toString(36).slice(2, 10)}`, event = "payment.captured") =>
  JSON.stringify({
    entity: "event",
    event,
    payload: { payment: { entity: { id: paymentId, order_id: orderId, status: "captured", amount: 100 } } },
  });

export const webhookSignature = (raw, secretValue = process.env.RAZORPAY_WEBHOOK_SECRET) =>
  crypto.createHmac("sha256", secretValue).update(raw).digest("hex");
