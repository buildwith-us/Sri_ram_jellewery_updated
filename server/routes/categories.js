import express from "express";
import { Category } from "../models/Category.js";
import { verifyJWT, requireAdmin } from "../middleware/auth.js";
import { validate, createCategorySchema, updateCategorySchema, objectIdParam } from "../middleware/validate.js";

const router = express.Router();

// Every :id here is an ObjectId; a malformed one is a 404, not a 500 (S8).
router.param("id", objectIdParam("Category"));

// GET /api/categories — list all categories
router.get("/", async (req, res) => {
  try {
    const categories = await Category.find().lean();
    const { Product } = await import("../models/Product.js");
    
    // Add itemCount to each category by querying the Product collection
    for (let cat of categories) {
      cat.itemCount = await Product.countDocuments({ category: cat.categoryName });
    }
    
    res.json(categories);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch categories" });
  }
});

// POST /api/categories — create category (admin)
router.post("/", verifyJWT, requireAdmin, validate(createCategorySchema), async (req, res) => {
  try {
    const category = await Category.create(req.body);
    res.status(201).json({ success: true, data: category, insertedId: category._id });
  } catch (error) {
    // The unique index on categoryName is the guarantee (B16b).
    if (error?.code === 11000) {
      return res.status(409).json({ error: "A category with this name already exists" });
    }
    res.status(500).json({ error: "Failed to create category" });
  }
});

// PATCH /api/categories/:id — update category (admin)
router.patch("/:id", verifyJWT, requireAdmin, validate(updateCategorySchema), async (req, res) => {
  try {
    const category = await Category.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );
    if (!category) {
      return res.status(404).json({ error: "Category not found" });
    }
    res.json({ success: true, data: category });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ error: "A category with this name already exists" });
    }
    res.status(500).json({ error: "Failed to update category" });
  }
});

// DELETE /api/categories/:id — delete category (admin)
router.delete("/:id", verifyJWT, requireAdmin, async (req, res) => {
  try {
    const category = await Category.findByIdAndDelete(req.params.id);
    if (!category) {
      return res.status(404).json({ error: "Category not found" });
    }
    res.json({ success: true, message: "Category deleted" });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete category" });
  }
});

export default router;
