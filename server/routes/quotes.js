import express from "express";
import { QuoteRequest } from "../models/QuoteRequest.js";
import { Product } from "../models/Product.js";
import { normalizeIndianPhone } from "../utils/phone.js";
import { nextQuoteId, isQuoteIdClash, ORDER_ID_ATTEMPTS } from "../utils/orderId.js";
import { verifyJWT, requireAdmin } from "../middleware/auth.js";
import { sendWhatsAppAlert } from "../utils/whatsapp.js";
import { validate, quoteRequestSchema, quoteStatusSchema, objectIdParam } from "../middleware/validate.js";

const router = express.Router();

// Every :id here is an ObjectId; a malformed one is a 404, not a 500 (S8).
router.param("id", objectIdParam("Quote request"));

// POST /api/quotes — submit an enquiry about a piece
//
// The piece is looked up in the catalogue by productId (or its Mongo id), and
// its name, picture and quote-only flag are copied from there — never from
// the request, which the schema strips them from. An unknown or switched-off
// piece is a 404. The signed-in customer is recorded, the mobile is stored as
// +91XXXXXXXXXX, and each enquiry gets an SRQ-… reference.
router.post("/", verifyJWT, validate(quoteRequestSchema), async (req, res) => {
  try {
    const { productId, customerName, customerMobile, channel = "form" } = req.body;

    const product = await Product.findOne({
      $or: [{ _id: /^[0-9a-fA-F]{24}$/.test(String(productId)) ? productId : null }, { productId }],
    })
      .select("productId name img image images isQuoteOnly isActive")
      .lean();
    if (!product || product.isActive === false) {
      return res.status(404).json({ error: "That piece isn't in our catalogue." });
    }

    const mobile = normalizeIndianPhone(customerMobile);
    if (!mobile.ok) return res.status(400).json({ error: mobile.reason });

    const fields = {
      productId: product.productId || String(product._id),
      productName: product.name,
      productImage: product.img || product.images?.[0] || product.image || undefined,
      isQuoteOnly: Boolean(product.isQuoteOnly),
      userId: req.user.userId,
      customerName,
      customerMobile: mobile.phone,
      channel,
    };

    // A clash with a reference already stored takes the next one.
    let quote;
    for (let attempt = 1; ; attempt += 1) {
      try {
        quote = await QuoteRequest.create({ ...fields, quoteId: await nextQuoteId() });
        break;
      } catch (saveError) {
        if (!isQuoteIdClash(saveError) || attempt >= ORDER_ID_ATTEMPTS) throw saveError;
      }
    }

    // Owner alert (non-blocking). Not configured yet: until it is, the owner
    // sees new enquiries in admin, where Quote Requests shows a pending count.
    sendWhatsAppAlert({
      customerName,
      customerMobile: mobile.phone,
      productName: product.name,
      isQuoteOnly: fields.isQuoteOnly,
      quoteId: quote.quoteId,
      channel,
    }).catch((err) => {
      console.warn("WhatsApp alert failed (non-critical):", err.message);
    });

    res.status(201).json({ success: true, data: quote });
  } catch (error) {
    console.error("Create quote error:", error);
    res.status(500).json({ error: "Failed to submit quote request" });
  }
});

// GET /api/quotes/summary — how many enquiries are waiting (admin only), for
// the count beside Quote Requests in the admin navigation.
router.get("/summary", verifyJWT, requireAdmin, async (req, res) => {
  try {
    res.json({ success: true, data: { pending: await QuoteRequest.countDocuments({ status: "Pending" }) } });
  } catch (error) {
    res.status(500).json({ error: "Failed to count quote requests" });
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
