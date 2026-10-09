import express from "express";
import { Product } from "../models/Product.js";
import { ProductView } from "../models/ProductView.js";
import { computePrice } from "../utils/computePrice.js";
import { getRates } from "../utils/getRates.js";
import { verifyJWT, optionalJWT, requireAdmin } from "../middleware/auth.js";
import { validate, createProductSchema, updateProductSchema, trackViewSchema } from "../middleware/validate.js";

const router = express.Router();

// Repeat views of the same product from the same session inside this window
// collapse into one. Long enough to absorb refreshes and back-navigation
// during a single shopping session, short enough that a genuine return visit
// later in the day still registers.
const VIEW_DEDUPE_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

// ─── Helpers ─────────────────────────────────────────────────────────────────
// Use shared getRates from utils

/**
 * Attach the live price to a product read for display. Every figure comes
 * from computePrice — the same call checkout makes — so the page can never
 * show a price that checkout does not charge.
 *
 *   price          what checkout charges (after any discount, GST included)
 *   originalPrice  before the discount
 *   discountPrice  calculated, never stored: equals `price` when a discount
 *                  applies, absent otherwise. (A legacy stored discountPrice
 *                  is ignored.)
 *   storedPrice    the raw stored `price` field — the making charge, or a
 *                  weightless piece's own price — so the admin edit form
 *                  edits what is stored, not the computed customer price.
 */
const withLivePrice = (product, rateMap) => {
  const storedPrice = product.price ?? null;
  delete product.discountPrice;
  const priceData = computePrice(product, rateMap);
  product.storedPrice = storedPrice;
  if (priceData !== undefined) {
    product.price = priceData.finalPrice;
    product.originalPrice = priceData.originalPrice;
    product.discountPercent = priceData.discountPercent;
    product.priceBreakdown = priceData.priceBreakdown;
    if (priceData.discountPercent > 0) product.discountPrice = priceData.finalPrice;
  }
  return product;
};

// Inactive products (the admin "active" toggle) are hidden from customers but
// still listed for administrators, who need to see them to switch them back on.
const isAdminRequest = (req) => req.user?.role === "ADMIN";
const visibleTo = (req, query = {}) => (isAdminRequest(req) ? query : { ...query, isActive: { $ne: false } });

const getPriceInjectedProducts = async (query = {}) => {
  const products = await Product.find(query).lean();
  const rateMap = await getRates();
  return products.map((product) => withLivePrice(product, rateMap));
};

// ─── Public Reads (JWT required per PRD) ─────────────────────────────────────

// GET /api/products/filter?category=...&minPrice=...&maxPrice=...
router.get("/filter", optionalJWT, async (req, res) => {
  try {
    const { category, minPrice = 0, maxPrice = 1000000, priceOrder, search } = req.query;

    let query = {};
    if (category && category !== "All" && category !== "undefined") {
      query.category = { $regex: new RegExp(`^${category}$`, 'i') };
    }

    if (search && search !== "undefined") {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { category: { $regex: search, $options: 'i' } }
      ];
    }

    let products = await getPriceInjectedProducts(visibleTo(req, query));

    if (minPrice) {
      products = products.filter(p => (p.price || 0) >= Number(minPrice));
    }
    if (maxPrice) {
      products = products.filter(p => (p.price || 0) <= Number(maxPrice));
    }

    if (priceOrder === "low-to-high") {
      products.sort((a, b) => (a.price || 0) - (b.price || 0));
    } else if (priceOrder === "high-to-low") {
      products.sort((a, b) => (b.price || 0) - (a.price || 0));
    }

    res.json(products);
  } catch (error) {
    console.error("Filter products error:", error);
    res.status(500).json({ error: "Failed to fetch filtered products" });
  }
});

// GET /api/products or /api/products?category=Rings&page=1
router.get("/", optionalJWT, async (req, res) => {
  try {
    const { category, sort, page = 1 } = req.query;

    let query = {};
    if (category && category !== "All") {
      query.category = { $regex: new RegExp(`^${category}$`, 'i') };
    }

    let products = await getPriceInjectedProducts(visibleTo(req, query));

    if (sort === "low-to-high") {
      products.sort((a, b) => (a.price || 0) - (b.price || 0));
    } else if (sort === "high-to-low") {
      products.sort((a, b) => (b.price || 0) - (a.price || 0));
    }

    res.json({
      success: true,
      data: products,
      totalPages: 1,
      currentPage: parseInt(page),
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

// GET /api/products/search?q=diamond
router.get("/search", optionalJWT, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) {
      const products = await getPriceInjectedProducts(visibleTo(req));
      return res.json({ success: true, data: products });
    }

    const query = {
      $or: [
        { name: { $regex: q, $options: 'i' } },
        { category: { $regex: q, $options: 'i' } }
      ]
    };

    const matched = await getPriceInjectedProducts(visibleTo(req, query));
    res.json({ success: true, data: matched });
  } catch (error) {
    res.status(500).json({ error: "Failed to search products" });
  }
});

// GET /api/products/:id
router.get("/:id", optionalJWT, async (req, res) => {
  try {
    const product = await Product.findOne(
      visibleTo(req, {
        $or: [
          { _id: req.params.id.match(/^[0-9a-fA-F]{24}$/) ? req.params.id : null },
          { productId: req.params.id }
        ].filter(Boolean)
      })
    ).lean();

    if (!product) {
      return res.status(404).json({ success: false, error: "Product not found" });
    }

    withLivePrice(product, await getRates());

    res.json({ success: true, data: product });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch product" });
  }
});

// POST /api/products/:id/view — record a product-detail view.
// Public: browsing is open to guests, so most views arrive without a token.
// optionalJWT attributes the view when the visitor happens to be signed in.
router.post("/:id/view", optionalJWT, validate(trackViewSchema), async (req, res) => {
  try {
    const { sessionId } = req.body;

    const product = await Product.findOne({
      $or: [
        { _id: req.params.id.match(/^[0-9a-fA-F]{24}$/) ? req.params.id : null },
        { productId: req.params.id },
      ].filter(Boolean),
    })
      .select("_id name img image images category")
      .lean();

    if (!product) {
      return res.status(404).json({ success: false, error: "Product not found" });
    }

    const productId = String(product._id);

    // Collapse repeat views from the same session within the window, so a
    // refresh, a back-navigation, or React StrictMode's double-invoked effect
    // all count once. The client also guards, but the client is not trusted.
    const since = new Date(Date.now() - VIEW_DEDUPE_WINDOW_MS);
    const recent = await ProductView.findOne({
      productId,
      sessionId,
      viewedAt: { $gte: since },
    })
      .select("_id")
      .lean();

    if (recent) {
      return res.json({ success: true, counted: false });
    }

    await ProductView.create({
      productId,
      productName: product.name,
      productImage: product.img || product.image || product.images?.[0],
      category: product.category,
      userId: req.user?.userId || null,
      sessionId,
    });

    res.status(201).json({ success: true, counted: true });
  } catch (error) {
    console.error("Track product view error:", error);
    res.status(500).json({ error: "Failed to record view" });
  }
});

// ─── Admin CRUD ──────────────────────────────────────────────────────────────

// POST /api/products — create product (admin)
router.post("/", verifyJWT, requireAdmin, validate(createProductSchema), async (req, res) => {
  try {
    const productData = {
      productId: req.body.productId || `p-${Date.now()}`,
      ...req.body,
    };
    const product = await Product.create(productData);
    res.status(201).json({ success: true, data: product });
  } catch (error) {
    console.error("Create product error:", error);
    res.status(500).json({ error: "Failed to create product" });
  }
});

// PATCH /api/products/:id — update product (admin)
router.patch("/:id", verifyJWT, requireAdmin, validate(updateProductSchema), async (req, res) => {
  try {
    const product = await Product.findOneAndUpdate(
      {
        $or: [
          { _id: req.params.id.match(/^[0-9a-fA-F]{24}$/) ? req.params.id : null },
          { productId: req.params.id }
        ].filter(Boolean)
      },
      req.body,
      { new: true }
    );

    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }
    res.json({ success: true, data: product });
  } catch (error) {
    res.status(500).json({ error: "Failed to update product" });
  }
});

// DELETE /api/products/:id — delete product (admin)
router.delete("/:id", verifyJWT, requireAdmin, async (req, res) => {
  try {
    const product = await Product.findOneAndDelete({
      $or: [
        { _id: req.params.id.match(/^[0-9a-fA-F]{24}$/) ? req.params.id : null },
        { productId: req.params.id }
      ].filter(Boolean)
    });

    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }
    res.json({ success: true, message: "Product deleted" });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete product" });
  }
});

export default router;
