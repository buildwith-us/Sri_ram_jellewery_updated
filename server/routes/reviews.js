import express from "express";
import { Review } from "../models/Review.js";
import { verifyJWT } from "../middleware/auth.js";
import { validate, createReviewSchema, objectIdParam } from "../middleware/validate.js";

const router = express.Router();

// Every :id here is an ObjectId; a malformed one is a 404, not a 500 (S8).
router.param("id", objectIdParam("Review"));

// GET /api/reviews/:productId — reviews for a specific product
router.get("/:productId", async (req, res) => {
  try {
    const reviews = await Review.find({ productId: req.params.productId })
      .sort({ date: -1 })
      .lean();
    res.json({ success: true, data: reviews });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch reviews" });
  }
});

// GET /api/reviews — all reviews (used by admin dashboard)
router.get("/", async (req, res) => {
  try {
    const reviews = await Review.find().sort({ date: -1 }).lean();
    res.json(reviews);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch reviews" });
  }
});

// POST /api/reviews — create a review (authenticated user)
router.post("/", verifyJWT, validate(createReviewSchema), async (req, res) => {
  try {
    const { productId, productName, review, rating } = req.body;

    if (!review || !rating) {
      return res.status(400).json({ error: "Review text and rating are required" });
    }

    const newReview = await Review.create({
      productId,
      productName,
      name: req.body.name || "Anonymous",
      review,
      rating: Number(rating),
      location: req.body.location || "",
      userId: req.user.userId,
    });

    res.status(201).json({ success: true, data: newReview });
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
