/**
 * What counts as revenue — ONE definition, used by every revenue figure the
 * admin sees (the dashboard revenue chart, the stats total, the Orders page
 * "Revenue Trend" chart, and the per-customer totals), so they cannot disagree.
 *
 *   Revenue = orders paid online
 *           + cash-on-delivery orders that have been DELIVERED (the cash is in)
 *   excluding orders that are cancelled, expired or rejected.
 *
 * Before this, the chart counted only orders whose paymentStatus was "paid"
 * (so a COD-only shop showed no revenue at all), the stats total counted every
 * order not cancelled (expired and rejected included), and per-customer totals
 * counted everything, cancelled and expired too (bug B6).
 */
export const REVENUE_MATCH = {
  orderStatus: { $nin: ["cancelled", "expired"] },
  approvalStatus: { $ne: "REJECTED" },
  $or: [
    // Paid online. paidAt is stamped on confirmation; older paid orders only
    // carry paymentStatus "paid".
    { paymentMethod: { $not: /^\s*cod\s*$/i }, $or: [{ paidAt: { $ne: null } }, { paymentStatus: "paid" }] },
    // Cash on delivery, once delivered.
    { paymentMethod: /^\s*cod\s*$/i, orderStatus: "delivered" },
  ],
};

export default REVENUE_MATCH;
