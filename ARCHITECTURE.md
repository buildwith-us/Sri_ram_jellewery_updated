# Sri Ram Jewellery — Architecture

A MERN storefront for a jewellery retailer. Prices are computed from a live
metal rate rather than stored, customers sign in by mobile OTP, and every order
waits on the owner's approval before a delivery date is promised.

Last verified against the codebase on 2026-08-03.

---

## 1. Stack

| Layer | Choice |
|---|---|
| Frontend | React 19, Vite 6, React Router 7, Tailwind 3 + daisyUI 5 |
| Server state | React Query (`react-query` v3) |
| Forms | react-hook-form |
| Backend | Node + Express (ESM), Mongoose 8 |
| Database | MongoDB Atlas |
| Auth | JWT access (30 min) + refresh (7 days, hashed at rest) |
| Payments | Razorpay (currently **test** keys) |
| Images | Cloudinary (signed server-side uploads) |
| SMS OTP | MSG91 (**unconfigured** — see §9) |
| Owner alerts | WhatsApp Cloud API (**unconfigured**) |
| Hosting | Vercel (`api/index` serverless + static build) |

```
npm run dev      # vite + node --watch server/index.js (concurrently)
npm run dev:ui   # frontend only
npm run dev:api  # backend only
npm run build    # vite build -> dist/
npm start        # production server
```

> `node --watch` does **not** watch `.env`. Restart the API after changing env vars.

---

## 2. Repository layout

```
src/                    React app
  main.jsx              ErrorBoundary > QueryClient > AuthProvider > RouterProvider
  routes/Routes.jsx     createBrowserRouter tree
  layouts/              MainLayout, DashboardLayout, ProductPageLayout
  pages/                one folder per screen (incl. pages/Dashboard/* for admin)
  components/           reusable UI
  hooks/                data access + shared behaviour
  context/              LoginGateContext
  providers/            AuthProvider
  utils/                apiConfig, errorMessage, cloudinaryImage, sessionId, authErrors

server/
  index.js              express app, middleware order, route mounting
  db/connect.js         serverless-safe connection cache + first-run seeding
  models/               13 Mongoose schemas
  routes/               15 routers
  middleware/           auth, validate (zod), rateLimit
  utils/                computePrice, getRates, rateGuards, whatsapp

api/index               Vercel serverless entry
```

---

## 3. Request pipeline

Order matters — this is the sequence in `server/index.js`:

```
app.set("trust proxy", 1)     required behind Vercel or express-rate-limit
  ↓                            cannot read X-Forwarded-For and throws
cors(allow-list)              callback returns (null, false), never an Error:
  ↓                            throwing crashed the process on disallowed origins
express.json()
  ↓
await connectDB()             per-request; skipped for /api/health.
  ↓                            Connecting at module load raced cold starts.
authLimiter                   on /api/auth/login|register|refresh
apiLimiter                    200 req/min on /api
  ↓
routers
```

### Serverless connection cache

`connectDB()` memoises the connection and the in-flight promise on `globalThis`,
so concurrent cold-start invocations share one connection attempt rather than
opening several.

---

## 4. Data model

13 collections. Fields that matter to behaviour:

**Product** — `weight`, `metalType` (`gold`|`silver`), `wastagePercent`,
`gstPercent` drive pricing. `price` is the **making charge**, not the customer
price. `isQuoteOnly` removes the product from pricing entirely. `isFixedPrice`
exists but is **no longer consulted** (§5).

**Order** — line items snapshot `unitPrice`, `weight` and `metalType` at
purchase time. Two independent axes:
- `orderStatus`: `processing` → `shipped` → `delivered` (or `cancelled`)
- `approvalStatus`: `PENDING` → `APPROVED` | `REJECTED`

plus `approvedAt`, `expectedDeliveryDate`, `rejectionReason`, `deliveredAt`.

**User** — `role` is `"ADMIN" | "USER"`. **There is no `admin` boolean**;
several components once gated on one and silently rendered empty.
Customers have `phone` + `otpHash`; only admins have `passwordHash`.

**GoldRate** — one document per metal, with `updatedAt` used for staleness.

**ProductView** — one document per view (event collection, not a counter),
with a 90-day TTL index.

**RefreshToken** — SHA-256 hash only; raw tokens are never stored.

---

## 5. Pricing — the core domain rule

`server/utils/computePrice.js` is the single source of truth. The frontend
imports this exact module for its admin preview so the two cannot drift.

```
metal    = weight × ratePerGram
wastage  = weight × (wastagePercent / 100) × ratePerGram
subtotal = metal + wastage
GST      = subtotal × (gstPercent / 100)
final    = subtotal + GST
```

Rules:
- `isQuoteOnly` → no price; the product shows "Price on Request".
- `weight === 0` → falls back to the stored `price`.
- Otherwise **always** computed from the live rate.
- `isFixedPrice` is ignored. It used to abort the calculation when `false`,
  which is backwards — "not a fixed price" means *compute from the rate*. The
  effect was that most products displayed their making charge as the full
  price, omitting metal value, wastage and GST.

Prices are **never trusted from the client**. `POST /api/orders` and
`POST /api/payment/create-order` both recompute every line server-side.

### Rate guards (`server/utils/rateGuards.js`)

- **Bounds**, per metal, because ₹96/g is nonsense for gold and normal for
  silver: gold ₹2,000–₹50,000, silver ₹20–₹5,000. Enforced by
  `updateRatesSchema`, so the API refuses out-of-band values whatever the caller.
- **Staleness**: `RATE_STALE_AFTER_DAYS` (default 3). Past that, both checkout
  paths return 503 for affected metals rather than charging against a stale
  figure, and the dashboard shows a warning. A stale rate is worse than none —
  it yields a confident wrong number.

---

## 6. Authentication

Two disjoint paths:

| | Customer | Admin |
|---|---|---|
| Route | `/login`, `/register` | `/admin-login` |
| Method | mobile + 6-digit OTP | email + password (bcrypt, 12 rounds) |
| Storage | `otpHash` + `otpExpiresAt` (5 min) | `passwordHash` |

Both mint the same JWT pair. `localStorage` keys: `sri-ram-access-token`,
`sri-ram-refresh-token`. `useAxiosSecure` attaches the access token and
silently refreshes once on a `TOKEN_EXPIRED` 401.

**Admins cannot sign in by OTP.** Refused at both `/otp/request` and
`/otp/verify`, with responses identical to any other number so the refusal does
not reveal that a number belongs to an administrator.

### The test-OTP bypass

`ALLOW_TEST_OTP === "true"` (exact string) accepts a fixed `123456` for any
number, so the app is usable while MSG91 is blocked on DLT registration.
It **fails closed**: unset, empty, `"false"` and `"TRUE"` all leave it off, and
`NODE_ENV` is not part of the decision. `TEST_OTP_PHONES` optionally narrows it
to named handsets. A startup warning states the active scope.

With neither SMS nor the bypass, `/otp/request` returns 503 rather than storing
a code nobody can receive.

### Authorisation

Server-side only, via `requireAdmin`. Of 75 routes: **30 admin, 29 authenticated
self-scoped, 1 optional-auth, 15 public**. No admin action relies on a hidden
client button. Client-side `role` checks are UI gates, never authorisation.

`optionalJWT` attaches a user when a valid token is present but never rejects —
used by view tracking, where guests are the majority.

---

## 7. Order lifecycle

```
customer places order            orderStatus=processing, approvalStatus=PENDING
  ├─ COD    → POST /api/orders                      → owner alert
  └─ Card   → POST /api/payment/create-order
              → Razorpay modal
              → POST /api/payment/verify (HMAC)     → owner alert
                                                      (on payment, not creation,
                                                       so abandoned attempts
                                                       raise nothing)
        ↓
owner approves    PATCH /api/orders/:id/approval
                  approvedAt = now
                  expectedDeliveryDate = now + DELIVERY_WINDOW_DAYS (15)
        ↓
fulfilment        PATCH /api/orders/:id/status
                  shipped/delivered refused while approvalStatus !== APPROVED
                  deliveredAt stamped once, on first transition
```

Guards: re-approval is rejected so a promised date cannot move after the
customer has seen it; an approved order cannot later be rejected; rejection
requires a reason. The delivery date is computed **server-side only**.

**Buy Now** bypasses the cart via router state. `Checkout` passes both the items
and the total through `PaymentContext` from one source, and the cart is not
cleared for a Buy Now purchase.

Every alert is fire-and-forget with a `.catch` — a notification must never be
the reason a paid order reports failure.

---

## 8. Frontend structure

### Route tree

```
/                        MainLayout      Home, Shop, Categories, About, Contact,
                                          Login, Register, AdminLogin, Wishlist,
                                          Checkout, OrderSuccess
/products/:id            ProductPageLayout   (separate root route, not nested)
    ├─ /description
    └─ /reviews
/dashboard               DashboardLayout  role-aware: admin sidebar or customer nav
    ├─ customer          myDashboard, myOrders, myAddress, addReview, accountDetails
    └─ admin             adminDashboard, adminProducts, adminCategories,
                         adminOrders, adminQuoteRequests, adminLiveRates,
                         adminUsers, adminMessages, adminSubscribers,
                         adminAddProducts
```

`ProductPageLayout` being a **separate root route** matters: it needs its own
`LoginGateProvider`, and `MainLayout`'s scroll-to-top does not apply to it.

### Notable pieces

- **`LoginGateContext`** — prompts a guest to sign in, stores the intended action
  in `sessionStorage`, and `useResumePendingAction` replays it after login, so
  "add to cart" survives the detour.
- **`ErrorBoundary`** — wraps `RouterProvider`, therefore imports nothing from
  react-router. A `<Link>` in the fallback throws for want of router context and
  masks the original error.
- **`PriceBreakdownPreview`** — imports the server's `computePrice` so the admin
  sees the exact number the customer will be charged.
- **`InvoiceDocument`** — printable invoice, hidden on screen and revealed by a
  print stylesheet, exported via the browser's Save as PDF. No third-party PDF
  service, so customer data never leaves the app.
- **`useTrackProductView`** — ref guard so StrictMode's double-invoked effect
  fires one request; the server deduplicates by session regardless.

---

## 9. Integrations

| Service | Env | Status |
|---|---|---|
| MongoDB Atlas | `MONGODB_URI` | ✅ |
| JWT | `JWT_SECRET` | ✅ — missing means 503 on auth, not a crash |
| Razorpay | `RAZORPAY_KEY_ID/SECRET` | ⚠️ test keys |
| Cloudinary | `CLOUDINARY_URL`, `VITE_CLOUDINARY_*` | ✅ signed uploads; secret is server-only |
| MSG91 | `MSG91_AUTH_KEY`, `MSG91_TEMPLATE_ID` | ❌ blocked on DLT registration |
| WhatsApp | `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `ADMIN_WHATSAPP_NUMBER` | ❌ alerts no-op, logged |
| Site URL | `PUBLIC_SITE_URL`, `VITE_PUBLIC_SITE_URL` | needed for the Razorpay logo (https only) and alert links |
| Test OTP | `ALLOW_TEST_OTP`, `TEST_OTP_PHONES` | ⚠️ on for the client demo |

Cloudinary uploads are signed by `GET /api/admin/cloudinary-signature`; the API
secret never reaches the browser.

---

## 10. Analytics

`ProductView` is an **event collection**, deliberately not a `viewCount` field:
a counter cannot answer "most viewed this week", cannot deduplicate per visitor,
and cannot separate guest from signed-in traffic.

- Write: `POST /api/products/:id/view` (public, `optionalJWT`)
- Dedupe: 30-minute window per `sessionId`, server-side
- Read: `GET /api/admin-dashboard/most-viewed?days=N`
- Retention: 90-day TTL index

`sessionId` is a random id in `sessionStorage` — it identifies nothing about the
visitor, it exists so one person refreshing is not counted as several. The admin
column therefore counts **sessions**, which approximates distinct visitors.

---

## 11. Recurring failure modes

Patterns that caused real bugs here. Worth checking against before adding code:

1. **Mongoose strict mode silently drops undeclared fields.** The API reports
   success and the data vanishes. Hit by `shippingAddress`, `size`, `carate`,
   `phone`/`subject` on contact messages.
2. **A field the model does not have.** `userFromDB?.admin` (it is `role`) left
   admin tables permanently empty. A positive check on a missing field fails
   closed and is merely broken; an inverted one fails open and is a hole.
3. **Overflow containers clip absolutely-positioned menus.** The shop filter
   dropdowns rendered invisibly outside a scroll container, so clicks landed on
   the backdrop behind them.
4. **Anything above `RouterProvider` cannot use router context.** A `<Link>` in
   a toast rendered by a `<Toaster>` outside the router crashed the whole app.
5. **Flags read backwards.** `isFixedPrice === false` aborting the price
   calculation cost the shop the entire metal value on most products.
6. **Third-party services for core documents.** Invoices posted customer data to
   an external renderer and produced nothing when it failed.

---

## 12. Known gaps

**Blocking launch**
- No legal pages (Privacy, Terms, Shipping, Returns, Cancellation) — Razorpay
  activation requires them; footer links point at `/`.
- Razorpay still on test keys; live keys need KYC.
- No email transport at all — no order confirmations to customer or owner.

**Data**
- Products still hotlink Unsplash placeholder images.
- Two `lh3.googleusercontent.com/aida-public/…` URLs remain (login background,
  Home masterpieces) and **will expire**.
- Seller GSTIN and per-item HSN codes are unset, so the invoice is a receipt
  rather than a GST tax invoice.

**Functional**
- Header search is decorative — `searchQuery` is stored and never used.
- Footer social links are `href="#"`.
- `/api/users/me/addresses` CRUD exists but nothing calls it; the app uses
  `/users/shipping-address`.
- No `metalType`/category consistency check — a "Men's Silver" product can carry
  `metalType: gold` and be priced against the gold rate.
- Seven unimported CSS files remain in the tree.

**Operational**
- `ALLOW_TEST_OTP=true` is live on the deployed preview; remove before launch.
- The seeded admin password appears in public git history and needs rotating.
