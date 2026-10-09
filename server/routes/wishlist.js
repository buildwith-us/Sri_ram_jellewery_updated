import express from "express";
import { Wishlist } from "../models/Wishlist.js";
import { Product } from "../models/Product.js";
import { verifyJWT } from "../middleware/auth.js";
import { validate, addToWishlistSchema } from "../middleware/validate.js";

const router = express.Router();

// GET /api/wishlist — user's wishlist items
router.get("/", verifyJWT, async (req, res) => {
  try {
    const userWishlist = await Wishlist.find({ userId: req.user.userId }).lean();

    // Saved pieces stay in the wishlist even if the owner switches them off
    // or deletes them — but each says whether it can still be bought, so the
    // page can show "no longer available" instead of a link to a 404.
    const ids = userWishlist.map((i) => i.productId);
    const objectIds = ids.filter((id) => /^[0-9a-fA-F]{24}$/.test(String(id)));
    const products = ids.length
      ? await Product.find({ $or: [{ productId: { $in: ids } }, { _id: { $in: objectIds } }] })
          .select("productId isActive")
          .lean()
      : [];
    const live = new Set();
    for (const p of products) {
      if (p.isActive === false) continue;
      live.add(String(p.productId));
      live.add(String(p._id));
    }

    res.json(userWishlist.map((item) => ({ ...item, available: live.has(String(item.productId)) })));
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch wishlist" });
  }
});

// POST /api/wishlist — add item to wishlist
router.post("/", verifyJWT, validate(addToWishlistSchema), async (req, res) => {
  try {
    const { productId, name, img, image, category, price } = req.body;

    const exists = await Wishlist.findOne({ userId: req.user.userId, productId });

    if (!exists) {
      // The line needs a name (the model requires it). Clients that omit it
      // used to get a 500 (S9c/d); take the product's own name instead.
      const lineName =
        name ||
        (
          await Product.findOne({
            $or: [{ _id: /^[0-9a-fA-F]{24}$/.test(String(productId)) ? productId : null }, { productId }],
          })
            .select("name")
            .lean()
        )?.name ||
        String(productId);
      const wishlistItem = new Wishlist({
        productId,
        userId: req.user.userId,
        email: req.user.email,
        name: lineName,
        img: img || image || "/logo.png",
        image: img || image || "/logo.png",
        category: category || "Jewellery",
        price,
      });
      await wishlistItem.save();
    }

    res.json({ insertedId: productId, success: true });
  } catch (error) {
    console.error("Wishlist POST Error:", error);
    res.status(500).json({ error: "Failed to add to wishlist" });
  }
});

// DELETE /api/wishlist/:itemId — remove item from wishlist
router.delete("/:itemId", verifyJWT, async (req, res) => {
  try {
    const result = await Wishlist.deleteMany({
      userId: req.user.userId,
      $or: [
        { _id: req.params.itemId.match(/^[0-9a-fA-F]{24}$/) ? req.params.itemId : null },
        { productId: req.params.itemId }
      ].filter(Boolean)
    });

    res.json({ deletedCount: result.deletedCount, success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete from wishlist" });
  }
});

// DELETE /api/wishlist?productId=... — backward compat (query-param based)
router.delete("/", verifyJWT, async (req, res) => {
  try {
    const { productId } = req.query;
    if (!productId) {
      return res.status(400).json({ error: "productId required" });
    }

    const result = await Wishlist.deleteMany({
      userId: req.user.userId,
      $or: [
        { _id: productId.match(/^[0-9a-fA-F]{24}$/) ? productId : null },
        { productId }
      ].filter(Boolean)
    });

    res.json({ deletedCount: result.deletedCount, success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete from wishlist" });
  }
});

export default router;
