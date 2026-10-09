import express from "express";
import { QuoteRequest } from "../models/QuoteRequest.js";
import { verifyJWT, requireAdmin } from "../middleware/auth.js";
import { sendWhatsAppAlert } from "../utils/whatsapp.js";
import { validate, quoteRequestSchema, quoteStatusSchema, objectIdParam } from "../middleware/validate.js";

const router = express.Router();

// Every :id here is an ObjectId; a malformed one is a 404, not a 500 (S8).
router.param("id", objectIdParam("Quote request"));

// POST /api/quotes — submit a quote request
router.post("/", verifyJWT, validate(quoteRequestSchema), async (req, res) => {
  try {
    const { productId, productName, productImage, customerName, customerMobile, isQuoteOnly } = req.body;

    if (!productId || !customerName || !customerMobile) {
      return res.status(400).json({
        error: "productId, customerName, and customerMobile are required",
      });
    }

    const quote = await QuoteRequest.create({
      productId,
      productName,
      productImage,
      customerName,
      customerMobile,
      isQuoteOnly,
    });

    // Send WhatsApp alert to admin (non-blocking)
    sendWhatsAppAlert({
      customerName,
      customerMobile,
      productName: productName || productId,
      isQuoteOnly,
    }).catch((err) => {
      console.warn("WhatsApp alert failed (non-critical):", err.message);
    });

    res.status(201).json({ success: true, data: quote });
  } catch (error) {
    console.error("Create quote error:", error);
    res.status(500).json({ error: "Failed to submit quote request" });
  }
});

// GET /api/quotes — list all quote requests (admin only)
router.get("/", verifyJWT, requireAdmin, async (req, res) => {
  try {
    const quotes = await QuoteRequest.find().sort({ createdAt: -1 }).lean();
    res.json({ success: true, data: quotes });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch quote requests" });
  }
});

// PATCH /api/quotes/:id/status — update quote request status (admin only)
router.patch("/:id/status", verifyJWT, requireAdmin, validate(quoteStatusSchema), async (req, res) => {
  try {
    const { status } = req.body;
    if (!["Pending", "Contacted", "Closed"].includes(status)) {
      return res.status(400).json({ error: "Invalid status value" });
    }

    const quote = await QuoteRequest.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    );

    if (!quote) {
      return res.status(404).json({ error: "Quote request not found" });
    }

    res.json({ success: true, data: quote });
  } catch (error) {
    res.status(500).json({ error: "Failed to update quote status" });
  }
});

export default router;
