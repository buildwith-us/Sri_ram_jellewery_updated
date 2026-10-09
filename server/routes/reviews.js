import express from "express";
import { Review } from "../models/Review.js";
import { Product } from "../models/Product.js";
import { Order } from "../models/Order.js";
import { User } from "../models/User.js";
import { verifyJWT, optionalJWT } from "../middleware/auth.js";
import { validate, createReviewSchema, objectIdParam } from "../middleware/validate.js";

const router = express.Router();

// Every :id here is an ObjectId; a malformed one is a 404, not a 500 (S8).
router.param("id", objectIdParam("Review"));

/**
 * What the public sees of a review. The reviewer's userId is an internal
 * account id and is never published (S5d/e); instead `mine` tells a signed-in
 * reader which reviews are their own (to hide the form and offer delete).
 */
const toPublic = (review, req) => {
  const { userId, ...rest } = review;
  return { ...rest, mine: Boolean(req.user?.userId && String(userId) === String(req.user.userId)) };
};

/** A product by its human key or its Mongo id. */
const findProduct = (id) =>
  Product.findOne({
    $or: [{ _id: /^[0-9a-fA-F]{24}$/.test(String(id)) ? id : null }, { productId: id }],
  }).lean();

// GET /api/reviews/:productId — reviews for a specific product
router.get("/:productId", optionalJWT, async (req, res) => {
  try {
    // Reviews are stored under the product's key; accept either identifier.
    const product = await findProduct(req.params.productId);
    const keys = [req.params.productId, product?.productId, product && String(product._id)].filter(Boolean);
    const reviews = await Review.find({ productId: { $in: keys } })
      .sort({ date: -1 })
      .lean();
    res.json({ success: true, data: reviews.map((r) => toPublic(r, req)) });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch reviews" });
  }
});

// GET /api/reviews — all reviews (site testimonials and product reviews)
router.get("/", optionalJWT, async (req, res) => {
  try {
    const reviews = await Review.find().sort({ date: -1 }).lean();
    res.json(reviews.map((r) => toPublic(r, req)));
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch reviews" });
  }
});

// POST /api/reviews — create a review (authenticated user)
//
// A PRODUCT review (productId given) must be about a real piece (S5b) that
// this customer has received — a DELIVERED order containing it (S5a);
// approval alone is not enough, they have not seen the piece yet. One review
// per customer per piece (S5f). A review without a productId is a site
// testimonial and has none of the purchase rules.
//
// The display name always comes from the account, never the request body, so
// nobody can post as "Sri Ram Jewellery (Official)" or as another customer
// (S5c).
router.post("/", verifyJWT, validate(createReviewSchema), async (req, res) => {
  try {
    const { productId, review, rating } = req.body;

    if (!review || !rating) {
      return res.status(400).json({ error: "Review text and rating are required" });
    }

    const author = await User.findById(req.user.userId).select("name").lean();
    if (!author) return res.status(401).json({ error: "Please sign in again" });
    const name = String(author.name || "").trim() || "Customer";

    let productKey;
    let productName;
    if (productId) {
      const product = await findProduct(productId);
      if (!product) {
        return res.status(404).json({ error: "That piece doesn't exist, so it can't be reviewed." });
      }
      productKey = product.productId || String(product._id);
      productName = product.name;

      const received = await Order.exists({
        userId: req.user.userId,
        orderStatus: "delivered",
        "items.productId": { $in: [product.productId, String(product._id)].filter(Boolean) },
      });
      if (!received) {
        return res.status(403).json({ error: "You can review a piece once it has been delivered to you." });
      }

      if (await Review.exists({ userId: req.user.userId, productId: productKey })) {
        return res.status(409).json({
          error: "You've already reviewed this piece. Delete your review if you'd like to write a new one.",
        });
      }
    }

    const newReview = await Review.create({
      productId: productKey,
      productName,
      name,
      review,
      rating: Number(rating),
      location: req.body.location || "",
      userId: req.user.userId,
    });

    res.status(201).json({ success: true, data: toPublic(newReview.toObject(), req) });
  } catch (error) {
    res.status(500).json({ error: "Failed to create review" });
  }
});

// DELETE /api/reviews/:id — delete a review (owner or admin)
router.delete("/:id", verifyJWT, async (req, res) => {
  try {
    const review = await Review.findById(req.params.id);
    if (!review) {
      return res.status(404).json({ error: "Review not found" });
    }
    if (review.userId !== req.user.userId && req.user.role !== "ADMIN") {
      return res.status(403).json({ error: "Not authorized to delete this review" });
    }
    await review.deleteOne();
    res.json({ success: true, message: "Review deleted" });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete review" });
  }
});

export default router;
