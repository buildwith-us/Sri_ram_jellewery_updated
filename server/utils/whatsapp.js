import dotenv from "dotenv";
dotenv.config();

/**
 * WhatsApp Cloud API (Meta official) alerts to the shop owner.
 *
 * Requires the following environment variables:
 *   WHATSAPP_TOKEN — permanent System User token from Meta Business. The token
 *     Meta shows first is a 24-hour test token; alerts stop silently when it
 *     expires.
 *   WHATSAPP_PHONE_NUMBER_ID — phone number ID from the WhatsApp Business API
 *   ADMIN_WHATSAPP_NUMBER — owner's number, international format, no '+'
 *     (e.g. 919876543210)
 *
 * None of these are configured yet, so every alert currently no-ops. The
 * skip is logged with the message that would have gone out, so the owner can
 * still see the event in the server log.
 */

const ADMIN_BASE_URL = process.env.PUBLIC_SITE_URL || "https://sriramjewellery.com";

/**
 * Shared transport. Returns false when unconfigured or on failure, so callers
 * can log without needing to care why — an alert must never be the reason an
 * order fails.
 */
const dispatch = async (text, skipSummary) => {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const adminNumber = process.env.ADMIN_WHATSAPP_NUMBER;

  if (!token || !phoneNumberId || !adminNumber) {
    console.log("📱 WhatsApp alert skipped — WHATSAPP_TOKEN/PHONE_NUMBER_ID/ADMIN_NUMBER not configured");
    console.log(`   Would have sent: ${skipSummary}`);
    return false;
  }

  const response = await fetch(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: adminNumber,
      type: "text",
      text: { body: text },
    }),
  });

  if (!response.ok) {
    const errorData = await response.text();
    throw new Error(`WhatsApp API error: ${response.status} — ${errorData}`);
  }

  console.log("✅ WhatsApp alert sent successfully");
  return true;
};

/**
 * Quote/enquiry alert, with the enquiry's reference and how it came in.
 */
export const sendWhatsAppAlert = async ({ customerName, customerMobile, productName, isQuoteOnly, quoteId, channel }) => {
  const alertHeader = isQuoteOnly ? "🔔 New Enquiry (Quote Required)" : "🔔 New Enquiry (Priced Item)";
  const ref = quoteId ? `Ref: ${quoteId}\n` : "";
  const via = channel === "whatsapp" ? "Via: WhatsApp — the customer is opening a chat with this reference\n" : "";

  return dispatch(
    `${alertHeader}\n\n` +
      ref +
      `Product: ${productName}\n` +
      `Customer: ${customerName}\n` +
      `Mobile: ${customerMobile}\n` +
      via +
      `\nView request: ${ADMIN_BASE_URL}/dashboard/adminQuoteRequests`,
    `Quote request ${quoteId || ""} from ${customerName} (${customerMobile}) for "${productName}"${channel === "whatsapp" ? " via WhatsApp" : ""}`
  );
};

const formatItems = (items = []) =>
  items
    .slice(0, 5)
    .map((i) => `• ${i.name || i.productId} ×${i.quantity || 1}`)
    .join("\n") + (items.length > 5 ? `\n• …and ${items.length - 5} more` : "");

const formatAmount = (n) => `₹${Number(n || 0).toLocaleString("en-IN")}`;

/**
 * New order placed. Sent for COD at order creation and for card orders only
 * after payment is confirmed, so abandoned checkout attempts raise nothing.
 *
 * Kept short deliberately — the owner reads this on a lock screen.
 *
 * The payment line comes from the order's own state (paidAt), never from the
 * method the customer chose. A chosen method is an intention; paidAt is the
 * fact. Reading the method is how an unpaid "upi" order reached the owner as
 * "Paid online".
 */
export const sendOrderAlert = async ({ order }) => {
  const method = order.paidAt ? "Paid online" : "Cash on Delivery";
  const customer = order.name || "Customer";
  const mobile =
    order.shippingAddress?.mobileNumber || order.shippingAddress?.number || order.phone || "—";

  return dispatch(
    `🛒 New Order — ${order.orderId}\n\n` +
      `${customer}\n` +
      `${mobile}\n\n` +
      `${formatItems(order.items)}\n\n` +
      `Total: ${formatAmount(order.totalAmount)}\n` +
      `Payment: ${method}\n\n` +
      `⏳ Awaiting your approval — the 15-day delivery window starts when you approve.\n` +
      `${ADMIN_BASE_URL}/dashboard/adminOrders`,
    `New order ${order.orderId} from ${customer} (${mobile}), ${formatAmount(order.totalAmount)}, ${method}`
  );
};

/**
 * Payment captured for an order that can no longer be fulfilled: the
 * reservation expired and the stock went elsewhere in the meantime.
 *
 * The one automatic event here that warrants interrupting the owner. Routine
 * expiries are logged and nothing more — abandoned checkouts are ordinary and
 * frequent, and alerting on each would train the owner to ignore this channel,
 * which would then cost them a real sale alert. This is the opposite case: the
 * shop is holding a customer's money with nothing to ship.
 */
export const sendRefundRequiredAlert = async ({ order, product, reason }) => {
  const customer = order.name || "Customer";
  const mobile =
    order.shippingAddress?.mobileNumber || order.shippingAddress?.number || order.phone || "—";
  // Why the money has to go back. The default is the original case: a payment
  // that arrived after its reservation expired, for a piece that sold out.
  const why =
    reason ||
    `Payment of ${formatAmount(order.totalAmount)} arrived after the reservation expired, and ${product} had already sold out.`;

  return dispatch(
    `🚨 REFUND NEEDED — ${order.orderId}\n\n` +
      `${customer}\n` +
      `${mobile}\n\n` +
      `${why}\n\n` +
      `The money is with us and there is nothing to ship. Please refund ${formatAmount(order.totalAmount)} to this customer.\n\n` +
      `${ADMIN_BASE_URL}/dashboard/adminOrders`,
    `REFUND NEEDED for ${order.orderId} — ${customer} (${mobile}) paid ${formatAmount(order.totalAmount)}. ${why}`
  );
};

/**
 * Approval decision, so the owner keeps a record of what they approved and
 * the delivery date it committed them to.
 */
export const sendOrderApprovalAlert = async ({ order }) => {
  const approved = order.approvalStatus === "APPROVED";
  const expected = order.expectedDeliveryDate
    ? new Date(order.expectedDeliveryDate).toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : null;

  const detail = approved
    ? `Deliver by: ${expected || "—"}`
    : `Reason: ${order.rejectionReason || "—"}`;

  return dispatch(
    `${approved ? "✅ Order Approved" : "❌ Order Declined"} — ${order.orderId}\n\n` +
      `${order.name || "Customer"}\n` +
      `Total: ${formatAmount(order.totalAmount)}\n` +
      `${detail}`,
    `Order ${order.orderId} ${approved ? "approved" : "declined"} — ${detail}`
  );
};
