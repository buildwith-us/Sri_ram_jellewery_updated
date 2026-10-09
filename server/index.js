import express from "express";
import cors from "cors";
import productsRouter from "./routes/products.js";
import cartRouter from "./routes/cart.js";
import wishlistRouter from "./routes/wishlist.js";
import ordersRouter from "./routes/orders.js";
import usersRouter from "./routes/users.js";
import authRouter from "./routes/auth.js";
import categoriesRouter from "./routes/categories.js";
import reviewsRouter from "./routes/reviews.js";
import adminRouter from "./routes/admin.js";
// Removed dead goldRate.js import
import ratesRouter from "./routes/rates.js";
import quotesRouter from "./routes/quotes.js";
import paymentRouter from "./routes/payment.js";
import adminDashboardRouter from "./routes/adminDashboard.js";
import contactRouter from "./routes/contact.js";
import newsletterRouter from "./routes/newsletter.js";
import cronRouter from "./routes/cron.js";
import connectDB from "./db/connect.js";
import { apiLimiter, authLimiter, refreshLimiter } from "./middleware/rateLimit.js";

const app = express();
const PORT = process.env.PORT || 5000;

// Vercel terminates TLS at its edge and forwards X-Forwarded-For. Without this,
// express-rate-limit throws a ValidationError because it cannot derive a
// trustworthy client IP.
app.set("trust proxy", 1);

// Warm the connection at module load, but don't rely on it having finished —
// the middleware below awaits it per-request.
connectDB().catch(() => {});

const allowedOrigins = (
  process.env.ALLOWED_ORIGINS ||
  "http://localhost:5173,https://sriramjewellery.in,https://www.sriramjewellery.in,https://jewellery-store-self.vercel.app"
)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow non-browser requests (no Origin header) and configured origins.
    // Pass `false` (never an Error) — an Error here becomes an unhandled
    // exception that crashes the process on every disallowed-origin request.
    callback(null, !origin || allowedOrigins.includes(origin));
  },
  credentials: true,
}));
// Keep the raw bytes alongside the parsed body. Razorpay signs the exact
// payload it sent, so the payment webhook must compute its HMAC over those
// bytes — re-serialising the parsed object would respace or reorder it and the
// digest would never match. Only the webhook route reads req.rawBody.
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

// Ensure MongoDB is connected before any route handler runs. On a serverless
// cold start the module-level connectDB() is still in flight, so without this
// early requests query an unconnected mongoose and fail intermittently.
app.use(async (req, res, next) => {
  if (req.path === "/api/health" || req.path === "/health") return next();
  try {
    await connectDB();
    next();
  } catch (error) {
    console.error("Database unavailable:", error.message);
    res.status(503).json({ error: "Database temporarily unavailable. Please try again." });
  }
});

// Normalize URL prefix for Vercel Serverless (if Vercel stripped /api)
app.use((req, res, next) => {
  if (!req.url.startsWith("/api") && req.url !== "/favicon.ico") {
    req.url = "/api" + (req.url.startsWith("/") ? req.url : "/" + req.url);
  }
  next();
});

// ─── Rate Limiting ───────────────────────────────────────────────────────────
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/register", authLimiter);
app.use("/api/auth/refresh", refreshLimiter); // not authLimiter: see B10
app.use("/api", apiLimiter);

// ─── API Routes ──────────────────────────────────────────────────────────────
// Auth — public endpoints (JWT issued here)
app.use("/api/auth", authRouter);

// All routes below require JWT (enforced in each router via verifyJWT middleware)
app.use("/api/products", productsRouter);
app.use("/api/cart", cartRouter);
app.use("/api/wishlist", wishlistRouter);
app.use("/api/orders", ordersRouter);
app.use("/api/users", usersRouter);
app.use("/api/categories", categoriesRouter);
app.use("/api/reviews", reviewsRouter);
app.use("/api/admin", adminRouter);
app.use("/api/rates", ratesRouter);
app.use("/api/quotes", quotesRouter);
app.use("/api/payment", paymentRouter);
app.use("/api/admin-dashboard", adminDashboardRouter);
app.use("/api/contact", contactRouter);
app.use("/api/newsletter", newsletterRouter);
// Scheduled maintenance — authenticated by CRON_SECRET, not by a user session.
app.use("/api/cron", cronRouter);

// Legacy gold-rate route (backward compat — also served at /api/rates)
// Removed dead /api/gold-rate mounts

// Navigation notifications endpoint
app.get("/api/nav-notifications", (req, res) => {
  res.json([
    { id: 1, message: "Welcome to Sri Ram Jewellery! Timeless gold and silver, crafted for every celebration." },
    { id: 2, message: "Free insured shipping on all orders above ₹50,000." },
  ]);
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date() });
});

// Only listen when running locally (not in Vercel serverless)
if (process.env.VERCEL !== "1") {
  app.listen(PORT, () => {
    console.log(`🚀 API Server running seamlessly on http://localhost:${PORT}`);
  });
}

// Export for Vercel serverless
export default app;
