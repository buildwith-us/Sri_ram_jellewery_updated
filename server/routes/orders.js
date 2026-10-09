import express from "express";
import { Order } from "../models/Order.js";
import { User } from "../models/User.js";
import { Cart } from "../models/Cart.js";
import { Product } from "../models/Product.js";
import { computePrice } from "../utils/computePrice.js";
import { getRateStatus, findUnpriceableMetalsForProducts, rateUnavailableMessage } from "../utils/getRates.js";
import { verifyJWT, requireAdmin } from "../middleware/auth.js";
import { sendOrderAlert, sendOrderApprovalAlert } from "../utils/whatsapp.js";
import { reserveStock, releaseStock, outOfStockMessage } from "../utils/stock.js";
import {
  validate,
  createOrderSchema,
  orderStatusSchema,
  orderApprovalSchema,
} from "../middleware/validate.js";

const router = express.Router();

// How long after the owner approves an order it is promised for delivery.
// Single source of truth — the client displays this date, it never computes it.
export const DELIVERY_WINDOW_DAYS = 15;

// Statuses an order may not reach until the owner has approved it. "processing"
// is the resting state of a new order, and "cancelled" must stay available.
const REQUIRES_APPROVAL = ["shipped", "delivered"];

// ─── Helpers ─────────────────────────────────────────────────────────────────

// ─── User Orders ─────────────────────────────────────────────────────────────

// GET /api/orders — user's own orders
router.get("/", verifyJWT, async (req, res) => {
  try {
    const orders = await Order.find({ userId: req.user.userId })
      .sort({ createdAt: -1 })
      .lean();
    res.json(orders);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

// GET /api/orders/admin/all — all orders (admin only)
router.get("/admin/all", verifyJWT, requireAdmin, async (req, res) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 }).lean();
    res.json(orders);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

// GET /api/orders/:id — single order
router.get("/:id", verifyJWT, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id).lean();
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }
    // Users can only see their own orders, admins can see all
    if (req.user.role !== "ADMIN" && order.userId !== req.user.userId) {
      return res.status(403).json({ error: "Not authorized to view this order" });
    }
    res.json({ success: true, data: order });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch order" });
  }
});

// POST /api/orders — create order with server-side price verification
router.post("/", verifyJWT, validate(createOrderSchema), async (req, res) => {
  try {
    const { items, shippingAddress, name } = req.body;

    if (!items || !items.length) {
      return res.status(400).json({ error: "Order must contain at least one item" });
    }


    // Refuse rather than price against a rate that cannot be trusted: a stale
    // one yields a confident, wrong number (how ₹96/gram gold reached
    // checkout), and a missing one leaves nothing to price from at all.
    const { rateMap, staleMetals } = await getRateStatus();
    const affected = findUnpriceableMetalsForProducts(
      await Product.find({
        $or: items.map((i) => ({
          $or: [
            { _id: i.productId?.match(/^[0-9a-fA-F]{24}$/) ? i.productId : null },
            { productId: i.productId },
          ].filter(Boolean),
        })).flat(),
      }).lean(),
      { rateMap, staleMetals }
    );
    if (affected.length) {
      return res.status(503).json({ error: rateUnavailableMessage(affected) });
    }

    // Server-side price verification (PRD: price never trusted from frontend)
    // — priced from the same rates just checked.
    let totalAmount = 0;
    let gstAmount = 0;
    const verifiedItems = [];

    for (const item of items) {
      const product = await Product.findOne({
        $or: [
          { _id: item.productId?.match(/^[0-9a-fA-F]{24}$/) ? item.productId : null },
          { productId: item.productId }
        ].filter(Boolean)
      }).lean();

      if (!product) {
        return res.status(400).json({ error: `Product not found: ${item.productId}` });
      }

      if (product.isQuoteOnly) {
        return res.status(400).json({ error: `Quote-only products cannot be ordered directly: ${product.name}` });
      }

      const priceData = computePrice(product, rateMap);
      // Never fall back to the stored `price` for a weighted product: that field
      // is the making charge, not the customer price. The rate check above
      // makes this unreachable; it stays as the last line of defence.
      if (!priceData && product.weight) {
        return res.status(503).json({ error: rateUnavailableMessage([product.metalType || "gold"]) });
      }
      // A weightless product sells at its stored price. Without one there is
      // nothing to charge — this used to reach the database as NaN and 500.
      const serverPrice = priceData?.finalPrice;
      // For a weightless piece a stored price of 0 is no price either: a blank
      // admin field used to save as 0, which would have sold it for nothing.
      // (Weighted pieces are untouched here — see B4-residual.)
      if (!Number.isFinite(serverPrice) || (!product.weight && serverPrice <= 0)) {
        return res.status(400).json({ error: `${product.name} cannot be ordered right now — it has no price set.` });
      }
      const quantity = item.quantity || 1;
      const lineTotal = serverPrice * quantity;

      // Calculate GST for this item
      const gstPercent = product.gstPercent || 0;
      // The GST row the customer was shown (computePrice's breakdown), so the
      // order's GST matches the page. Weightless pieces have no breakdown.
      const unitGst = priceData.priceBreakdown
        ? priceData.priceBreakdown.gst
        : serverPrice - serverPrice / (1 + gstPercent / 100);
      gstAmount += unitGst * quantity;

      totalAmount += lineTotal;

      verifiedItems.push({
        productId: product.productId || product._id.toString(),
        name: product.name,
        image: product.img || product.image || (product.images && product.images[0]),
        quantity,
        unitPrice: serverPrice,
        weight: product.weight,
        metalType: product.metalType,
        category: product.category,
      });
    }

    // Take stock before the order exists. A refusal here leaves nothing behind —
    // reserveStock rolls back its own partial work.
    const reservation = await reserveStock(verifiedItems);
    if (!reservation.ok) {
      return res.status(409).json({ error: outOfStockMessage(reservation) });
    }

    // Profile phone, for the owner's delivery call (see Order.phone).
    const customer = await User.findById(req.user.userId).select("phone").lean();

    const newOrder = new Order({
      phone: customer?.phone || undefined,
      orderId: `ORD-${Date.now()}`,
      userId: req.user.userId,
      email: req.user.email,
      name: name || undefined,
      items: verifiedItems,
      totalAmount: Math.round(totalAmount),
      gstAmount: Math.round(gstAmount),
      shippingAddress,
      // createOrderSchema admits only cash on delivery, so this route never
      // writes an online order — those exist only once Razorpay has one.
      paymentMethod: "cod",
      paymentStatus: "unpaid",
      orderStatus: "processing",
      stockReserved: true,
    });

    try {
      await newOrder.save();
    } catch (saveError) {
      // Stock is already out of the catalogue but no order holds it. Put it
      // back rather than quietly losing inventory to a failed write.
      await releaseStock(verifiedItems);
      throw saveError;
    }

    // Owner alert, fire-and-forget. Card orders are announced from the payment
    // verification handler instead, so an abandoned checkout raises nothing.
    // A notification must never be the reason a saved order reports failure.
    sendOrderAlert({ order: newOrder }).catch((err) =>
      console.error("Owner order alert failed (non-critical):", err.message)
    );

    // Clear cart after successful order — but a "Buy Now" purchase bypasses the
    // cart entirely, so it must leave whatever the user had saved intact.
    if (!req.body.buyNow) {
      await Cart.deleteMany({ userId: req.user.userId });
    }

    res.status(201).json({ success: true, data: newOrder });
  } catch (error) {
    console.error("Create order error:", error);
    res.status(500).json({ error: "Failed to create order" });
  }
});

// PATCH /api/orders/:id/status — admin update order status
router.patch("/:id/status", verifyJWT, requireAdmin, validate(orderStatusSchema), async (req, res) => {
  try {
    const { status } = req.body;

    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    // Enforced here rather than only in the admin UI: an unapproved order has
    // no delivery window, so it must not be able to reach a fulfilment status.
    if (REQUIRES_APPROVAL.includes(status) && order.approvalStatus !== "APPROVED") {
      return res.status(400).json({
        error: "Approve this order before marking it shipped or delivered",
      });
    }

    order.orderStatus = status;

    // Stamped once, on the first transition into delivered, so re-saving a
    // delivered order does not move the date the customer was shown.
    if (status === "delivered" && !order.deliveredAt) {
      order.deliveredAt = new Date();
    }

    await order.save();

    res.json({ success: true, data: order });
  } catch (error) {
    res.status(500).json({ error: "Failed to update order status" });
  }
});

// PATCH /api/orders/:id/approval — owner approves or rejects an order (admin)
router.patch("/:id/approval", verifyJWT, requireAdmin, validate(orderApprovalSchema), async (req, res) => {
  try {
    const { approvalStatus, rejectionReason } = req.body;

    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    // Idempotent guard: re-approving would silently push the promised delivery
    // date back, after the customer has already been shown the first one.
    if (order.approvalStatus === approvalStatus) {
      return res.status(400).json({
        error: `This order is already ${approvalStatus.toLowerCase()}`,
      });
    }
    if (order.approvalStatus === "APPROVED" && approvalStatus === "REJECTED") {
      return res.status(400).json({ error: "An approved order cannot be rejected" });
    }

    if (approvalStatus === "APPROVED") {
      const approvedAt = new Date();
      order.approvalStatus = "APPROVED";
      order.approvedAt = approvedAt;
      // Computed server-side only — a client-supplied date is never trusted.
      order.expectedDeliveryDate = new Date(
        approvedAt.getTime() + DELIVERY_WINDOW_DAYS * 24 * 60 * 60 * 1000
      );
      order.rejectionReason = null;
    } else {
      order.approvalStatus = "REJECTED";
      order.rejectionReason = rejectionReason || null;
      order.approvedAt = null;
      order.expectedDeliveryDate = null;

      // A rejected order is never fulfilled, so its pieces go back on sale.
      if (order.stockReserved) {
        await releaseStock(order.items);
        order.stockReserved = false;
      }
    }

    await order.save();

    sendOrderApprovalAlert({ order }).catch((err) =>
      console.error("Owner approval alert failed (non-critical):", err.message)
    );

    res.json({ success: true, data: order });
  } catch (error) {
    console.error("Order approval error:", error);
    res.status(500).json({ error: "Failed to update order approval" });
  }
});

// PATCH /api/orders/:id/cancel — user cancels their own order (within 7 days, while still processing)
router.patch("/:id/cancel", verifyJWT, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }
    if (order.userId !== req.user.userId) {
      return res.status(403).json({ error: "Not authorized to cancel this order" });
    }
    if (order.orderStatus !== "processing") {
      return res.status(400).json({ error: "Only processing orders can be cancelled" });
    }

    const diffInDays = (Date.now() - order.createdAt.getTime()) / (1000 * 60 * 60 * 24);
    if (diffInDays > 7) {
      return res.status(400).json({ error: "No orders can be cancelled after 7 days of ordering" });
    }

    order.orderStatus = "cancelled";

    // Put the pieces back on sale. Guarded by the flag rather than by status
    // alone: cancellation and owner rejection are separate fields, so without
    // it an order that was rejected and then cancelled would restock twice.
    if (order.stockReserved) {
      await releaseStock(order.items);
      order.stockReserved = false;
    }

    await order.save();

    res.json({ success: true, data: order });
  } catch (error) {
    console.error("Cancel order error:", error);
    res.status(500).json({ error: "Failed to cancel order" });
  }
});

// DELETE /api/orders/delete-cart-items — clear user's cart
router.delete("/delete-cart-items", verifyJWT, async (req, res) => {
  try {
    const result = await Cart.deleteMany({ userId: req.user.userId });
    res.json({ deletedCount: result.deletedCount, success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete cart items" });
  }
});

export default router;
