import express from "express";
import { Cart } from "../models/Cart.js";
import { verifyJWT } from "../middleware/auth.js";
import { Product } from "../models/Product.js";
import { computePrice } from "../utils/computePrice.js";
import { getRates } from "../utils/getRates.js";
import { validate, addToCartSchema, updateCartItemSchema } from "../middleware/validate.js";
const router = express.Router();

/** Most of one piece a single bag line may hold — matches the checkout schema. */
const MAX_LINE_QUANTITY = 99;

// GET /api/cart — user's cart items
router.get("/", verifyJWT, async (req, res) => {
  try {
    const userCart = await Cart.find({ userId: req.user.userId }).lean();
    if (!userCart.length) return res.json([]);

    const rateMap = await getRates();
    const productIds = userCart.map((item) => item.productId);
    const products = await Product.find({ productId: { $in: productIds } }).lean();
    const productMap = products.reduce((acc, p) => { acc[p.productId] = p; return acc; }, {});

    const dynamicCart = userCart.map((item) => {
      const product = productMap[item.productId];
      let computedPrice = parseFloat(item.price || 0); // Fallback to stale price if product deleted
      
      if (product) {
        const pricing = computePrice(product, rateMap);
        if (pricing && pricing.finalPrice) {
          computedPrice = pricing.finalPrice;
        }
      }
      
      return {
        ...item,
        price: computedPrice, // Override the old price with the new dynamically computed price
        // The rate already baked into `price`. Cart documents don't store it,
        // so without this the checkout summary cannot itemise the GST the
        // customer is being charged — it could only repeat the total twice.
        gstPercent: product?.gstPercent ?? 0,
      };
    });

    res.json(dynamicCart);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch cart" });
  }
});

// GET /api/cart/subtotal
router.get("/subtotal", verifyJWT, async (req, res) => {
  try {
    const userCart = await Cart.find({ userId: req.user.userId }).lean();
    if (!userCart.length) {
      return res.json({ subtotal: "0.00", gstAmount: "0.00", subtotalExGst: "0.00", totalItems: 0 });
    }

    const rateMap = await getRates();
    const productIds = userCart.map((item) => item.productId);
    const products = await Product.find({ productId: { $in: productIds } }).lean();
    const productMap = products.reduce((acc, p) => { acc[p.productId] = p; return acc; }, {});

    let subtotal = 0;
    let gstAmount = 0;

    for (const item of userCart) {
      const product = productMap[item.productId];
      let computedPrice = parseFloat(item.price || 0);

      if (product) {
        const pricing = computePrice(product, rateMap);
        if (pricing && pricing.finalPrice) {
          computedPrice = pricing.finalPrice;
        }
      }
      const quantity = item.quantity || 1;
      subtotal += computedPrice * quantity;

      // The computed price already includes GST, so the tax has to be taken
      // back out of it rather than added on top. Same formula the order routes
      // use, and it stays server-side for the same reason the price does: the
      // cart document carries no gstPercent, so the client cannot derive this.
      const gstPercent = product?.gstPercent || 0;
      if (gstPercent > 0) {
        const priceBeforeGst = computedPrice / (1 + gstPercent / 100);
        gstAmount += (computedPrice - priceBeforeGst) * quantity;
      }
    }

    res.json({
      // Unchanged: the GST-inclusive amount the customer pays. Callers that
      // only read `subtotal` keep working.
      subtotal: subtotal.toFixed(2),
      gstAmount: gstAmount.toFixed(2),
      subtotalExGst: (subtotal - gstAmount).toFixed(2),
      totalItems: userCart.length,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch cart subtotal" });
  }
});

// POST /api/cart — add item to cart
router.post("/", verifyJWT, validate(addToCartSchema), async (req, res) => {
  try {
    const { productId, name, img, image, category, price, quantity = 1 } = req.body;

    let cartItem = await Cart.findOne({ userId: req.user.userId, productId });

    if (cartItem) {
      // The same 1–99 bound the request schema enforces, applied to the line's
      // total: repeated adds used to push one line past it. Refused, never
      // silently capped — a customer's quantity is never changed for them.
      if ((cartItem.quantity || 0) + quantity > MAX_LINE_QUANTITY) {
        return res.status(400).json({
          error: `You can have at most ${MAX_LINE_QUANTITY} of one piece in your bag (you already have ${cartItem.quantity}).`,
        });
      }
      cartItem.quantity += quantity;
      await cartItem.save();
    } else {
      cartItem = new Cart({
        productId,
        userId: req.user.userId,
        email: req.user.email,
        name,
        img: img || image || "/logo.png",
        image: img || image || "/logo.png",
        category: category || "Jewellery",
        price,
        quantity,
      });
      await cartItem.save();
    }

    res.json({ insertedId: productId, success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to add to cart" });
  }
});

// PATCH /api/cart/:itemId — update cart item quantity
router.patch("/:itemId", verifyJWT, validate(updateCartItemSchema), async (req, res) => {
  try {
    const { quantity } = req.body;
    const cartItem = await Cart.findOne({
      userId: req.user.userId,
      $or: [
        { _id: req.params.itemId.match(/^[0-9a-fA-F]{24}$/) ? req.params.itemId : null },
        { productId: req.params.itemId }
      ].filter(Boolean)
    });

    if (!cartItem) {
      return res.status(404).json({ error: "Cart item not found" });
    }

    if (quantity !== undefined) {
      if (quantity <= 0) {
        await cartItem.deleteOne();
        return res.json({ success: true, message: "Item removed from cart" });
      }
      cartItem.quantity = quantity;
    }

    await cartItem.save();
    res.json({ success: true, data: cartItem });
  } catch (error) {
    res.status(500).json({ error: "Failed to update cart item" });
  }
});

// DELETE /api/cart/:itemId — remove item from cart
router.delete("/:itemId", verifyJWT, async (req, res) => {
  try {
    const result = await Cart.deleteMany({
      userId: req.user.userId,
      $or: [
        { _id: req.params.itemId.match(/^[0-9a-fA-F]{24}$/) ? req.params.itemId : null },
        { productId: req.params.itemId }
      ].filter(Boolean)
    });

    res.json({ deletedCount: result.deletedCount, success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete from cart" });
  }
});

export default router;
