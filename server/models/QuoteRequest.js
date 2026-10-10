import mongoose from "mongoose";

/**
 * A customer's enquiry about a piece.
 *
 * productName, productImage and isQuoteOnly are copied from the catalogue
 * when the enquiry is made, never taken from the request: the route used to
 * store whatever the browser sent, so an enquiry could name a piece or show a
 * picture the shop does not have.
 */
const QuoteRequestSchema = new mongoose.Schema({
  // SRQ-YYYYMMDD-NNNN (utils/orderId.js). Older enquiries have none.
  quoteId: { type: String, unique: true, sparse: true },
  productId: { type: String, required: true },
  productName: { type: String },
  productImage: { type: String },
  isQuoteOnly: { type: Boolean, default: false },
  // Who sent it (the route requires sign-in).
  userId: { type: String },
  // "whatsapp": saved by "Ask on WhatsApp", which then opened a chat with the
  // shop carrying quoteId. "form": the enquiry form only.
  channel: { type: String, enum: ["form", "whatsapp"], default: "form" },
  customerName: { type: String, required: true },
  customerMobile: { type: String, required: true }, // +91XXXXXXXXXX
  status: { type: String, enum: ['Pending', 'Contacted', 'Closed'], default: 'Pending' },
  createdAt: { type: Date, default: Date.now },
});

export const QuoteRequest = mongoose.model("QuoteRequest", QuoteRequestSchema);
