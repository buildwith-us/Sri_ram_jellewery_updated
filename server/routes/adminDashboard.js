import express from "express";
import { REVENUE_MATCH } from "../utils/revenue.js";
import { Order } from "../models/Order.js";
import { Wishlist } from "../models/Wishlist.js";
import { Product } from "../models/Product.js";
import { Category } from "../models/Category.js";
import { Review } from "../models/Review.js";
import { ProductView } from "../models/ProductView.js";
import { verifyJWT, requireAdmin } from "../middleware/auth.js";

const router = express.Router();

// ─── GET /api/admin-dashboard/revenue ──────────────────────────────────────
// Revenue over time — grouped by day/week/month
router.get("/revenue", verifyJWT, requireAdmin, async (req, res) => {
  try {
    const { period = "daily" } = req.query;

    let dateFormat;
    switch (period) {
      case "weekly":
        dateFormat = { $dateToString: { format: "%Y-W%V", date: "$createdAt" } };
        break;
      case "monthly":
        dateFormat = { $dateToString: { format: "%Y-%m", date: "$createdAt" } };
        break;
      default: // daily
        dateFormat = { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } };
    }

    const revenue = await Order.aggregate([
      { $match: REVENUE_MATCH }, // see utils/revenue.js
      {
        $group: {
          _id: dateFormat,
          totalRevenue: { $sum: "$totalAmount" },
          orderCount: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
      { $project: { period: "$_id", totalRevenue: 1, orderCount: 1, _id: 0 } },
    ]);

    res.json({ success: true, data: revenue });
  } catch (error) {
    console.error("Revenue stats error:", error);
    res.status(500).json({ error: "Failed to fetch revenue data" });
  }
});

// ─── GET /api/admin-dashboard/sales-by-category ─────────────────────────────
// Which categories generate the most revenue/orders
router.get("/sales-by-category", verifyJWT, requireAdmin, async (req, res) => {
  try {
    const salesByCategory = await Order.aggregate([
      { $match: { orderStatus: { $ne: "cancelled" } } },
      { $unwind: "$items" },
      {
        $group: {
          _id: "$items.category",
          totalRevenue: { $sum: { $multiply: ["$items.unitPrice", "$items.quantity"] } },
          totalOrders: { $sum: 1 },
          totalUnits: { $sum: "$items.quantity" },
        },
      },
      { $sort: { totalRevenue: -1 } },
      {
        $project: {
          category: "$_id",
          totalRevenue: 1,
          totalOrders: 1,
          totalUnits: 1,
          _id: 0,
        },
      },
    ]);

    res.json({ success: true, data: salesByCategory });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch sales by category" });
  }
});

// ─── GET /api/admin-dashboard/best-selling ──────────────────────────────────
// Highest units sold / highest revenue products
router.get("/best-selling", verifyJWT, requireAdmin, async (req, res) => {
  try {
    const bestSelling = await Order.aggregate([
      { $match: { orderStatus: { $ne: "cancelled" } } },
      { $unwind: "$items" },
      {
        $group: {
          _id: "$items.productId",
          productName: { $first: "$items.name" },
          productImage: { $first: "$items.image" },
          category: { $first: "$items.category" },
          totalUnitsSold: { $sum: "$items.quantity" },
          totalRevenue: { $sum: { $multiply: ["$items.unitPrice", "$items.quantity"] } },
        },
      },
      { $sort: { totalUnitsSold: -1 } },
      { $limit: 10 },
      {
        $project: {
          productId: "$_id",
          productName: 1,
          productImage: 1,
          category: 1,
          totalUnitsSold: 1,
          totalRevenue: 1,
          _id: 0,
        },
      },
    ]);

    res.json({ success: true, data: bestSelling });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch best-selling products" });
  }
});

// ─── GET /api/admin-dashboard/most-wishlisted ───────────────────────────────
// Products with the most wishlist adds (engagement signal)
router.get("/most-wishlisted", verifyJWT, requireAdmin, async (req, res) => {
  try {
    const mostWishlisted = await Wishlist.aggregate([
      {
        $group: {
          _id: "$productId",
          productName: { $first: "$name" },
          productImage: { $first: "$img" },
          category: { $first: "$category" },
          wishlistCount: { $sum: 1 },
        },
      },
      { $sort: { wishlistCount: -1 } },
      { $limit: 10 },
      {
        $project: {
          productId: "$_id",
          productName: 1,
          productImage: 1,
          category: 1,
          wishlistCount: 1,
          _id: 0,
        },
      },
    ]);

    res.json({ success: true, data: mostWishlisted });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch most-wishlisted products" });
  }
});

// ─── GET /api/admin-dashboard/stats ─────────────────────────────────────────
// General stats overview (used by existing useAdminStats hook)
router.get("/stats", verifyJWT, requireAdmin, async (req, res) => {
  try {
    const totalOrders = await Order.countDocuments();
    const totalRevenue = await Order.aggregate([
      { $match: REVENUE_MATCH }, // see utils/revenue.js
      { $group: { _id: null, total: { $sum: "$totalAmount" } } },
    ]);
    const totalProducts = await Product.countDocuments();
    const totalCategories = await Category.countDocuments();

    res.json({
      totalOrders,
      totalRevenue: totalRevenue[0]?.total || 0,
      totalProducts,
      totalCategories,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch admin stats" });
  }
});

// ─── GET /api/admin-dashboard/top-selling-categories ────────────────────────
// (backward compat for useAdminStats)
router.get("/top-selling-categories", verifyJWT, requireAdmin, async (req, res) => {
  try {
    const totalCategories = await Category.countDocuments();
    const topCategories = await Order.aggregate([
      { $unwind: "$items" },
      {
        $group: {
          _id: "$items.category",
          count: { $sum: "$items.quantity" },
          revenue: { $sum: { $multiply: ["$items.unitPrice", "$items.quantity"] } },
        },
      },
      { $sort: { revenue: -1 } },
      { $limit: 5 },
      { $project: { category: "$_id", count: 1, revenue: 1, _id: 0 } },
    ]);

    res.json({ totalCategories, topCategories });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch top selling categories" });
  }
});

// ─── GET /api/admin-dashboard/income-stats ──────────────────────────────────
// Monthly income for the last 6 months
router.get("/income-stats", verifyJWT, requireAdmin, async (req, res) => {
  try {
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const incomeStats = await Order.aggregate([
      { $match: { createdAt: { $gte: sixMonthsAgo }, ...REVENUE_MATCH } }, // see utils/revenue.js
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } },
          income: { $sum: "$totalAmount" },
          orders: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
      { $project: { month: "$_id", income: 1, orders: 1, _id: 0 } },
    ]);

    res.json(incomeStats);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch income stats" });
  }
});

// ─── GET /api/admin-dashboard/popular-products ──────────────────────────────
router.get("/popular-products", verifyJWT, requireAdmin, async (req, res) => {
  try {
    const popular = await Product.find()
      .sort({ sold: -1 })
      .limit(10)
      .lean();
    res.json(popular);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch popular products" });
  }
});

// ─── GET /api/admin-dashboard/recent-reviews ────────────────────────────────
router.get("/recent-reviews", verifyJWT, requireAdmin, async (req, res) => {
  try {
    const reviews = await Review.find().sort({ date: -1 }).limit(5).lean();
    res.json(reviews);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch recent reviews" });
  }
});

// ─── GET /api/admin-dashboard/most-viewed ───────────────────────────────────
// Most-viewed products. `days` (default 30) scopes the window, which is the
// whole reason views are stored as events rather than a counter on Product.
router.get("/most-viewed", verifyJWT, requireAdmin, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 50);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const mostViewed = await ProductView.aggregate([
      { $match: { viewedAt: { $gte: since } } },
      {
        $group: {
          _id: "$productId",
          productName: { $first: "$productName" },
          productImage: { $first: "$productImage" },
          category: { $first: "$category" },
          viewCount: { $sum: 1 },
          // Views are already deduplicated per session on write, so counting
          // distinct sessions separates reach from repeat interest.
          uniqueVisitors: { $addToSet: "$sessionId" },
          signedInViews: {
            $sum: { $cond: [{ $ifNull: ["$userId", false] }, 1, 0] },
          },
        },
      },
      {
        $project: {
          _id: 0,
          productId: "$_id",
          productName: 1,
          productImage: 1,
          category: 1,
          viewCount: 1,
          uniqueVisitors: { $size: "$uniqueVisitors" },
          signedInViews: 1,
        },
      },
      { $sort: { viewCount: -1 } },
      { $limit: limit },
    ]);

    res.json({ success: true, data: mostViewed, periodDays: days });
  } catch (error) {
    console.error("Most viewed products error:", error);
    res.status(500).json({ error: "Failed to fetch most-viewed products" });
  }
});

export default router;
