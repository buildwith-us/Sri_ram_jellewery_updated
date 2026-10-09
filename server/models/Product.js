import mongoose from "mongoose";

const ProductSchema = new mongoose.Schema({
  productId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  price: { type: Number },
  discountPrice: { type: Number },
  discountPercentage: { type: Number },
  category: { type: String, required: true },
  img: { type: String },
  image: { type: String },
  images: [{ type: String }],
  description: { type: String },
  // What the admin form's Description and Advantages fields write. The
  // Description tab reads details; `description` is kept equal to
  // details.description (products route) for the places that read that.
  // Before this was declared, strict mode silently dropped both (S9a).
  details: {
    description: { type: String },
    advantages: { type: [String], default: undefined },
  },
  rating: { type: Number, default: 0 },
  isFlashSale: { type: Boolean, default: false },
  flashSale: { type: Boolean, default: false },
  featured: { type: Boolean, default: false },
  newArrival: { type: Boolean, default: false },
  stock: { type: Number, default: 0 },
  sold: { type: Number, default: 0 },
  badge: { type: String },
  addedAt: { type: Date, default: Date.now },
  isActive: { type: Boolean, default: true },

  // Pricing fields (PRD §4.4)
  weight: { type: Number, default: 0 },           // grams
  wastagePercent: { type: Number, default: 0 },    // %
  gstPercent: { type: Number, default: 0 },        // % — manual, per product
  metalType: { type: String, enum: ["gold", "silver"], default: "gold" },
  isQuoteOnly: { type: Boolean, default: false },  // true → "Get Quote" button, no price
  size: { type: String },
  carate: { type: Number },

  // Deprecated — kept for backward compat migration, use isQuoteOnly instead
  isFixedPrice: { type: Boolean, default: true },
});

export const Product = mongoose.model("Product", ProductSchema);
