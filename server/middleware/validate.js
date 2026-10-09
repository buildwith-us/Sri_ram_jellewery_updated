import { z } from "zod";
import { RATE_BOUNDS, rateOutOfBoundsMessage } from "../utils/rateGuards.js";

/**
 * Express middleware factory: validate request body against a Zod schema.
 * @param {z.ZodSchema} schema
 */
export const validate = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.body);

  if (!result.success) {
    // Zod 4 exposes the failure list as `.issues`; the old `.errors` alias is
    // gone, and reading it here turned every 400 into a 500.
    const issues = result.error.issues.map((e) => ({
      field: e.path.join("."),
      message: e.message,
    }));
    return res.status(400).json({
      error: issues[0]?.message || "Validation failed",
      details: issues,
    });
  }

  // Hand the parsed value onward so coercion (numeric strings from HTML forms)
  // and stripping of unknown keys actually reach the route handler.
  req.body = result.data;
  next();
};

// ─── Schemas ─────────────────────────────────────────────────────────────────

/**
 * A required, non-empty string carrying one message for every way it can fail.
 * `.min(1, msg)` alone only covers the empty-string case — a missing key falls
 * through to Zod's default "expected string, received undefined", which the
 * client renders verbatim to the customer.
 */
const requiredString = (message, max) => {
  let schema = z.string({ error: message }).min(1, message);
  return max ? schema.max(max, message) : schema;
};

export const registerSchema = z.object({
  name: z.string().min(1, "Name is required").optional(),
  email: z.email("Valid email is required"),
  password: z.string({ error: "Password is required" }).min(6, "Password must be at least 6 characters"),
});

export const loginSchema = z.object({
  email: z.email("Valid email is required"),
  password: requiredString("Password is required"),
});

export const refreshSchema = z.object({
  refreshToken: requiredString("Refresh token is required"),
});

// Admin forms post numbers as strings, and clear optional numeric fields by
// sending null. `coerce` handles the former, `nullish` the latter.
const optionalNumber = z.coerce.number().nullish();
const optionalPercent = z.coerce
  .number()
  .min(0, "Must be between 0 and 100")
  .max(100, "Must be between 0 and 100")
  .nullish();

export const createProductSchema = z.object({
  name: requiredString("Product name is required"),
  category: requiredString("Category is required"),
  metalType: z.enum(["gold", "silver"]).nullish(),
  // Never negative: a negative weight priced the piece below zero. 0 is valid
  // and means "sell at the stored price".
  weight: z.coerce.number().min(0, "Weight cannot be negative").nullish(),
  wastagePercent: optionalPercent,
  gstPercent: optionalPercent,
  price: z.coerce.number().min(0, "Price cannot be negative").nullish(),
  // Calculated by computePrice from discountPercentage, never stored: a
  // stored figure went stale with the metal rate and drifted from checkout.
  discountPrice: z.unknown().transform(() => undefined).optional(),
  // The discount, as a percentage of the whole piece, applied before GST.
  discountPercentage: optionalPercent,
  stock: z.coerce.number().int("Stock must be a whole number").min(0, "Stock cannot be negative").nullish(),
  carate: optionalNumber,
  isQuoteOnly: z.coerce.boolean().nullish(),
}).passthrough();

// PATCH may touch any subset of fields, so nothing is required — but whatever
// is sent still has to be the right shape.
export const updateProductSchema = createProductSchema.partial();

// Bounds live in rateGuards.js so the API, the admin form and the dashboard
// warning cannot drift apart. A rate outside these is an order-of-magnitude
// slip, and one of those already reached production.
export const updateRatesSchema = z.object({
  gold: z.coerce
    .number({ error: rateOutOfBoundsMessage("gold") })
    .min(RATE_BOUNDS.gold.min, rateOutOfBoundsMessage("gold"))
    .max(RATE_BOUNDS.gold.max, rateOutOfBoundsMessage("gold"))
    .optional(),
  silver: z.coerce
    .number({ error: rateOutOfBoundsMessage("silver") })
    .min(RATE_BOUNDS.silver.min, rateOutOfBoundsMessage("silver"))
    .max(RATE_BOUNDS.silver.max, rateOutOfBoundsMessage("silver"))
    .optional(),
}).refine(
  (data) => data.gold !== undefined || data.silver !== undefined,
  { message: "Must provide at least one rate to update (gold or silver)" }
);

export const quoteRequestSchema = z.object({
  productId: requiredString("Product ID is required"),
  productName: z.string().optional(),
  productImage: z.string().optional(),
  customerName: requiredString("Customer name is required"),
  customerMobile: z.string({ error: "Valid mobile number is required" }).min(10, "Valid mobile number is required"),
  isQuoteOnly: z.coerce.boolean().nullish(),
});

export const quoteStatusSchema = z.object({
  status: z.enum(["Pending", "Contacted", "Closed"], {
    message: "Status must be Pending, Contacted, or Closed",
  }),
});

// Cash on delivery is the only method POST /api/orders can honour: it is the
// one order that is legitimately unpaid when placed. Card, UPI, QR and
// netbanking all go through /api/payment/create-order, where Razorpay collects
// the money first. Accepting any string here let "upi" create an unpaid order
// that the customer saw as confirmed and the owner was told was paid.
// Case and padding are normalised, so "COD" is cash on delivery too.
const cashOnDeliveryOnly = z.preprocess(
  (v) => (typeof v === "string" ? v.trim().toLowerCase() : v),
  z.literal("cod", {
    error: "Only Cash on Delivery orders can be placed here. Card and UPI payments go through secure checkout.",
  })
);

// What a checkout line is, defined once for both checkout routes — COD
// (POST /api/orders) and card/UPI (POST /api/payment/create-order) — so they
// cannot disagree. The card route used to accept anything: a quantity of -2
// cut the amount charged and added stock, and 0.01 bought a piece for 1% of
// its price. Bounds match the cart's (1–99, whole pieces).
const checkoutLines = z
  .array(
    z.object({
      productId: requiredString("Product ID is required"),
      quantity: z.coerce
        .number({ error: "Quantity must be a whole number" })
        .int("Quantity must be a whole number")
        .min(1, "Quantity must be at least 1")
        .max(99, "Quantity cannot exceed 99")
        .optional(),
    }).passthrough(),
    { error: "At least one item required" }
  )
  .min(1, "At least one item required");

const checkoutFields = {
  items: checkoutLines,
  shippingAddress: z.object({}).passthrough().nullish(),
  name: z.string().optional(),
  buyNow: z.coerce.boolean().optional(),
};

export const createOrderSchema = z.object({
  ...checkoutFields,
  // Optional for backward compatibility: an omitted method has always meant COD.
  paymentMethod: cashOnDeliveryOnly.optional(),
}).passthrough();

// The same lines and fields. No paymentMethod: this route only ever creates
// Razorpay orders, so the COD-only rule above does not apply to it.
export const createPaymentOrderSchema = z.object(checkoutFields).passthrough();

export const orderStatusSchema = z.object({
  status: z.enum(
    ["processing", "shipped", "delivered", "cancelled"],
    { message: "Invalid order status" }
  ),
});

export const orderApprovalSchema = z.object({
  approvalStatus: z.enum(["APPROVED", "REJECTED"], {
    message: "Approval status must be APPROVED or REJECTED",
  }),
  rejectionReason: z.string().max(500, "Reason must be under 500 characters").nullish(),
}).refine(
  (data) => data.approvalStatus !== "REJECTED" || Boolean(data.rejectionReason?.trim()),
  { message: "A reason is required when rejecting an order", path: ["rejectionReason"] }
);

// ─── Analytics ───────────────────────────────────────────────────────────────
// sessionId is a client-generated opaque id used only to deduplicate views.
// Bounded in length so it cannot be used to smuggle bulk data into the store.

export const trackViewSchema = z.object({
  sessionId: requiredString("Session ID is required", 64),
});

// ─── Cart / wishlist ─────────────────────────────────────────────────────────
// `price` is accepted for display only — orders recompute every price from the
// live metal rate server-side, so a tampered value here cannot affect billing.
const cartItemBase = {
  productId: requiredString("Product ID is required"),
  name: z.string().optional(),
  img: z.string().optional(),
  image: z.string().optional(),
  category: z.string().optional(),
  price: optionalNumber,
};

export const addToCartSchema = z.object({
  ...cartItemBase,
  quantity: z.coerce.number().int().positive("Quantity must be at least 1").max(99, "Quantity cannot exceed 99").optional(),
});

export const updateCartItemSchema = z.object({
  quantity: z.coerce.number({ error: "Quantity is required" }).int().min(0, "Quantity cannot be negative").max(99, "Quantity cannot exceed 99"),
});

export const addToWishlistSchema = z.object(cartItemBase);

// ─── Reviews ─────────────────────────────────────────────────────────────────

export const createReviewSchema = z.object({
  productId: z.string().optional(),
  productName: z.string().optional(),
  review: requiredString("Review text is required", 2000),
  rating: z.coerce
    .number({ error: "Rating must be between 1 and 5" })
    .min(1, "Rating must be between 1 and 5")
    .max(5, "Rating must be between 1 and 5"),
  name: z.string().optional(),
  location: z.string().optional(),
});

// ─── Categories ──────────────────────────────────────────────────────────────
// Both handlers pass req.body straight to Mongoose, so an explicit shape here
// is what stops arbitrary keys reaching the document.

// Field names mirror the Category model exactly. An earlier version used
// name/img, which the model and the admin form do not use, so every unknown
// key was stripped and creation failed on a missing "name".
export const createCategorySchema = z.object({
  categoryName: requiredString("Category name is required", 100),
  categoryPic: z.string().max(1000).optional().or(z.literal("")),
  image: z.string().max(1000).optional().or(z.literal("")),
  productCount: z.coerce.number().min(0).optional(),
});

export const updateCategorySchema = createCategorySchema.partial();

// ─── Public forms ────────────────────────────────────────────────────────────

export const contactSchema = z.object({
  name: requiredString("Name is required", 100),
  email: z.email("Valid email is required"),
  message: requiredString("Message is required", 5000),
  phone: z.string().max(20).optional(),
  subject: z.string().max(200).optional(),
});

export const newsletterSchema = z.object({
  email: z.email("Valid email is required"),
});

// ─── User profile ────────────────────────────────────────────────────────────

// Not passthrough: this is a self-service endpoint, so any key it forwards is a
// key the caller controls on their own user document. The handler allowlists
// today, but stripping unknown keys here means a later change to
// `findByIdAndUpdate(userId, req.body)` cannot become privilege escalation.
// role and passwordHash are deliberately absent — role changes go through the
// requireAdmin route.
export const updateProfileSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100, "Name must be under 100 characters").optional(),
  // The delivery contact number. Validated as an Indian mobile, stored as
  // +91XXXXXXXXXX and de-duplicated by the handler. Not a sign-in identity.
  phone: z.string().max(20).optional(),
  photoURL: z.string().max(500).optional(),
  // The email address IS the sign-in identity, verified by the code the
  // customer signed in with. It cannot be set here: an unverified change would
  // hand the account to whoever owns the new address, and clearing it would
  // lock the customer out. Refused loudly rather than silently stripped, so a
  // client still sending it finds out. (A verified change flow is separate.)
  email: z
    .never({ error: "Your email address is how you sign in, so it can't be changed here. Please contact the shop to change it." })
    .optional(),
});

// Admin edits to another user (PATCH /api/users/:id). A whitelist, and strict:
// any other key is a 400, not a silent write. The route used to pass the body
// straight to findByIdAndUpdate, so an admin request could set passwordHash
// (handing a customer account a password the admin chose), otpHash, emailKey,
// an unnormalised phone, or a role outside the enum (bug S1).
export const adminUpdateUserSchema = z.strictObject({
  name: z.string().trim().min(1, "Name is required").max(100, "Name must be under 100 characters").optional(),
  role: z.enum(["ADMIN", "USER"], { error: "Role must be ADMIN or USER" }).optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: requiredString("Current password is required"),
  newPassword: z.string({ error: "New password is required" }).min(6, "New password must be at least 6 characters"),
});

// Mirrors the AddressBook form, which posts the whole address as one object.
// `number` is assembled client-side as "+91 9876543210"; `country` is pinned to
// India, so it is accepted but not trusted for anything.
export const shippingAddressSchema = z.object({
  firstName: requiredString("First name is required", 100),
  lastName: z.string().max(100).optional().or(z.literal("")),
  email: z.email("Valid email is required"),
  streetAddress: requiredString("Street address is required", 500),
  city: requiredString("City is required", 100),
  state: requiredString("State is required", 100),
  postalCode: z.string({ error: "Enter a valid 6-digit PIN code" }).regex(/^\d{6}$/, "Enter a valid 6-digit PIN code"),
  mobileNumber: z.string({ error: "Valid mobile number is required" }).min(10, "Valid mobile number is required").max(15, "Valid mobile number is required"),
  number: z.string().max(25).optional(),
  country: z.string().max(100).optional(),
}).passthrough();

// ─── Route parameters ────────────────────────────────────────────────────────

/**
 * router.param handler for routes whose :id is a MongoDB ObjectId. A malformed
 * id used to reach Mongoose and come back as a CastError → 500 (bug S8); it is
 * now the same 404 a well-formed id for a missing record gets.
 *
 * Not for routes whose id may also be a human key (products' productId, cart
 * and wishlist items) — those look up by either and handle both themselves.
 */
export const objectIdParam = (label) => (req, res, next, id) => {
  if (/^[0-9a-fA-F]{24}$/.test(String(id))) return next();
  const name = typeof label === "function" ? label(req) : label;
  return res.status(404).json({ error: `${name} not found` });
};
