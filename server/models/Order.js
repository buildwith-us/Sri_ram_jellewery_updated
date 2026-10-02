import mongoose from "mongoose";

const OrderSchema = new mongoose.Schema({
  orderId: { type: String, required: true, unique: true },
  userId: { type: String },          // Firebase UID
  email: { type: String },  // Optional — OTP customers may not have email
  name: { type: String },

  // Structured line items (PRD §5)
  items: [{
    productId: { type: String, required: true },
    name: { type: String },
    image: { type: String },
    quantity: { type: Number, default: 1 },
    unitPrice: { type: Number },
    weight: { type: Number },
    metalType: { type: String, enum: ["gold", "silver"] },
    category: { type: String },
  }],

  totalAmount: { type: Number, required: true },
  gstAmount: { type: Number, default: 0 },
  orderStatus: { type: String, default: "processing" },

  // Owner approval (PRD: an order is not live until the owner confirms it).
  // The delivery window is counted from approvedAt, not from createdAt.
  approvalStatus: {
    type: String,
    enum: ["PENDING", "APPROVED", "REJECTED"],
    default: "PENDING",
  },
  approvedAt: { type: Date, default: null },
  expectedDeliveryDate: { type: Date, default: null },
  rejectionReason: { type: String, default: null },

  // Set once, when the order first transitions to delivered. Null on legacy
  // orders, which are deliberately not backfilled.
  deliveredAt: { type: Date, default: null },

  // True while this order is holding stock it took at creation. Cleared when
  // the stock is returned (cancellation, owner rejection), so that the two
  // release paths — which key off different fields — cannot restock twice.
  // Legacy orders default to false: they predate stock tracking, so they hold
  // nothing and must not put anything back.
  stockReserved: { type: Boolean, default: false },

  // Set by the stale-reservation sweeper when an unpaid card order times out.
  // Distinguishes an abandoned checkout from the two deliberate cancellations:
  // a customer cancel leaves orderStatus "cancelled" with no expiredAt, and an
  // owner rejection sets approvalStatus REJECTED with rejectionReason.
  expiredAt: { type: Date, default: null },
  cancellationReason: { type: String, default: null },

  // Payment captured for an order whose stock had already been released and
  // could not be taken back — the shop has the customer's money and nothing to
  // ship. Needs a human and a refund, so it is a flag rather than a status.
  refundRequired: { type: Boolean, default: false },

  // Razorpay (PRD §4.1)
  razorpayOrderId: { type: String },
  razorpayPaymentId: { type: String },
  paymentStatus: { type: String },
  // Normalised on every write, so "COD" and "cod" cannot be two methods.
  paymentMethod: { type: String, lowercase: true, trim: true },

  // Stamped once, when a payment is first confirmed — by whichever of the
  // webhook or the browser's verify call arrives first. This is what makes that
  // transition idempotent, so the owner is alerted exactly once per order.
  paidAt: { type: Date, default: null },

  shippingAddress: { type: Object },
  createdAt: { type: Date, default: Date.now },

});

export const Order = mongoose.model("Order", OrderSchema);
