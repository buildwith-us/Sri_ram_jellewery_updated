import express from "express";
import { REVENUE_MATCH } from "../utils/revenue.js";
import { v2 as cloudinary } from "cloudinary";
import { User } from "../models/User.js";
import { Order } from "../models/Order.js";
import { Category } from "../models/Category.js";
import { verifyJWT, requireAdmin } from "../middleware/auth.js";

const router = express.Router();



// ─── Total Spent (per user) ─────────────────────────────────────────────────
router.get("/total-spent", verifyJWT, requireAdmin, async (req, res) => {
  try {
    // Grouped by userId, not email.
    //
    // Grouping by "$email" collapsed every order from an OTP customer into a
    // single `_id: null` bucket, because those accounts have no email — so the
    // admin table showed one shared total against every customer lacking one.
    // userId is written on every order at creation and is the real identity, so
    // it is both correct and unambiguous. This gets more visible, not less, now
    // that some customers will have an email and others won't.
    //
    // `email` is still projected for display and for reconciling old records,
    // but it is no longer what the rows are keyed on.
    const result = await Order.aggregate([
      // Only what counts as revenue (utils/revenue.js) — not cancelled,
      // expired or rejected orders, nor unpaid ones.
      { $match: REVENUE_MATCH },
      {
        $group: {
          _id: "$userId",
          totalSpent: { $sum: "$totalAmount" },
          orderCount: { $sum: 1 },
          email: { $last: "$email" },
        },
      },
      { $project: { userId: "$_id", email: 1, totalSpent: 1, orderCount: 1, _id: 0 } },
      { $sort: { totalSpent: -1 } },
    ]);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch total spent" });
  }
});

// ─── Cloudinary Signed Upload ────────────────────────────────────────────────
// Signs a direct-to-Cloudinary upload so the API secret never reaches the browser.
router.get("/cloudinary-signature", verifyJWT, requireAdmin, (req, res) => {
  if (!process.env.CLOUDINARY_URL) {
    return res.status(503).json({ error: "Cloudinary is not configured" });
  }

  const timestamp = Math.round(Date.now() / 1000);
  const signature = cloudinary.utils.api_sign_request(
    { timestamp },
    cloudinary.config().api_secret
  );

  res.json({
    signature,
    timestamp,
    apiKey: cloudinary.config().api_key,
    cloudName: cloudinary.config().cloud_name,
  });
});

export default router;
