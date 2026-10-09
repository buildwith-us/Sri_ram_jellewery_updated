/**
 * The customer price of a product. The single source of truth: the product
 * page, the cart, the admin preview (PriceBreakdownPreview imports this file)
 * and both checkout routes all call it, so they cannot drift apart.
 *
 *   metal     = weight × rate_per_gram
 *   wastage   = weight × wastage% × rate_per_gram
 *   subtotal  = metal + wastage
 *   discount  = subtotal × discount%          (the whole piece, before GST)
 *   GST       = (subtotal − discount) × GST%   (charged on the discounted amount)
 *   payable   = subtotal − discount + GST
 *
 * Rounding: `finalPrice` is the exact payable rounded to the rupee, as it
 * always has been. The metal, wastage and discount rows are rounded on their
 * own, and the GST row takes up the difference, so the rows shown to the
 * customer always add up to exactly what checkout charges. (Rounding every row
 * independently could leave the rows ₹1 off the total.)
 *
 * The discount used to be applied only for display, in the products route, so
 * the page showed the discounted price while checkout charged the full one.
 *
 * isFixedPrice is deliberately not consulted. The guard used to bail out when
 * it was false, which is backwards: "not a fixed price" means the piece should
 * be priced from the live metal rate.
 *
 * @param {Object} product
 * @param {Object} rateMap — { gold: number, silver: number } rates per gram
 * @returns {undefined | {
 *   finalPrice: number,          payable — what checkout charges
 *   originalPrice: number,       before the discount (equals finalPrice when none)
 *   discountPercent: number,
 *   priceBreakdown: null | { metalValue, wastageValue, discount, gst, ratePerGram }
 * }}
 *   undefined for quote-only products, and for a weighted product whose metal
 *   has no rate (never a stale or partial price).
 */
export const computePrice = (product, rateMap) => {
  if (product.isQuoteOnly) {
    return undefined;
  }

  const discountPercent = Math.min(Math.max(Number(product.discountPercentage) || 0, 0), 100);
  const keep = 1 - discountPercent / 100;

  const weight = product.weight || 0;
  if (weight === 0) {
    // Weightless pieces sell at their stored price (minus any discount). A
    // missing price stays missing — the checkout routes refuse it.
    const stored = product.price;
    const priced = typeof stored === "number" && Number.isFinite(stored);
    return {
      finalPrice: priced ? Math.round(stored * keep) : stored,
      originalPrice: stored,
      discountPercent,
      priceBreakdown: null,
    };
  }

  // Get the appropriate metal rate
  const metalType = product.metalType || "gold";
  const ratePerGram = rateMap ? (rateMap[metalType] || 0) : 0;

  if (ratePerGram === 0) {
    console.error(`[computePrice] Data Error: Missing rate for metalType '${metalType}'. Product ID: ${product._id || product.productId}`);
    return undefined; // Degrade to quote-only rather than showing a stale price
  }

  const wastagePercent = product.wastagePercent || 0;
  const gstPercent = product.gstPercent || 0;

  const metal = weight * ratePerGram;
  const wastage = weight * (wastagePercent / 100) * ratePerGram;
  const subtotal = metal + wastage;
  const discount = subtotal * (discountPercent / 100);
  const taxable = subtotal - discount;
  const gst = taxable * (gstPercent / 100);

  const finalPrice = Math.round(taxable + gst);
  const metalValue = Math.round(metal);
  const wastageValue = Math.round(wastage);
  const discountValue = Math.round(discount);

  return {
    finalPrice,
    originalPrice: Math.round(subtotal * (1 + gstPercent / 100)),
    discountPercent,
    priceBreakdown: {
      metalValue,
      wastageValue,
      discount: discountValue,
      // Absorbs the rounding of the other rows (see above).
      gst: finalPrice - (metalValue + wastageValue - discountValue),
      ratePerGram,
    },
  };
};
