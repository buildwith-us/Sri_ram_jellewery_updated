import React from "react";
// Imported from the server rather than reimplemented: this preview has to be
// the number the customer will actually be charged, and a second copy of the
// formula would drift from it silently. The module is plain arithmetic with no
// server-only imports.
import { computePrice } from "../../../server/utils/computePrice.js";

const money = (n) => `₹${Math.round(Number(n) || 0).toLocaleString("en-IN")}`;

/**
 * Live price breakdown shown while the owner fills in the product form.
 *
 * Entering weight, wastage and GST does not make the resulting price obvious —
 * which is how a 100g item priced against a wrong gold rate reached the shop
 * at ₹1.2 crore without anyone noticing. Showing the computed figure as it is
 * typed makes an order-of-magnitude mistake visible at the point it is made.
 */
const PriceBreakdownPreview = ({ weight, wastagePercent, gstPercent, metalType, discountPercentage, rates }) => {
  const metal = metalType || "gold";
  const rate = rates?.[metal]?.ratePerGram;
  const isStale = rates?.[metal]?.isStale;

  const numericWeight = Number(weight);

  if (!rate) {
    return (
      <div className="mx-6 mt-8 p-4 rounded bg-surface-container border border-outline-variant/30 text-sm text-on-surface-variant">
        Live {metal} rate unavailable — the price cannot be previewed.
      </div>
    );
  }

  if (!numericWeight || numericWeight <= 0) {
    return (
      <div className="mx-6 mt-8 p-4 rounded bg-surface-container border border-outline-variant/30">
        <p className="font-label-caps text-[11px] uppercase tracking-[0.15em] text-on-surface-variant mb-1">
          Customer price
        </p>
        <p className="text-sm text-on-surface-variant">
          Enter a weight to see what the customer will pay.
        </p>
        <p className="text-xs text-on-surface-variant mt-2">
          Live {metal} rate: <strong>{money(rate)}/g</strong>
        </p>
      </div>
    );
  }

  // Same shape the server builds a product from, so the same branch runs.
  const result = computePrice(
    {
      weight: numericWeight,
      wastagePercent: Number(wastagePercent) || 0,
      gstPercent: Number(gstPercent) || 0,
      metalType: metal,
      discountPercentage: Number(discountPercentage) || 0,
      isQuoteOnly: false,
    },
    { [metal]: rate }
  );

  const b = result?.priceBreakdown;

  return (
    <div className="mx-6 mt-8 p-5 rounded bg-surface-container border border-primary/30">
      <div className="flex items-baseline justify-between mb-3">
        <p className="font-label-caps text-[11px] uppercase tracking-[0.15em] text-primary">
          Customer price
        </p>
        <span className="text-[11px] text-on-surface-variant">
          {metal} @ {money(rate)}/g
        </span>
      </div>

      {isStale && (
        <p className="mb-3 text-xs text-error font-semibold">
          This {metal} rate is stale — update it before relying on this price.
        </p>
      )}

      <p className="font-display-lg text-headline-md text-primary mb-4">
        {money(result?.finalPrice)}
      </p>

      {b && (
        <dl className="space-y-1.5 text-sm">
          <div className="flex justify-between">
            <dt className="text-on-surface-variant">
              Metal value ({numericWeight}g × {money(rate)})
            </dt>
            <dd className="text-on-surface">{money(b.metalValue)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-on-surface-variant">Wastage ({Number(wastagePercent) || 0}%)</dt>
            <dd className="text-on-surface">{money(b.wastageValue)}</dd>
          </div>
          {b.discount > 0 && (
            <div className="flex justify-between">
              <dt className="text-on-surface-variant">Discount ({result.discountPercent}%)</dt>
              <dd className="text-on-surface">− {money(b.discount)}</dd>
            </div>
          )}
          <div className="flex justify-between">
            <dt className="text-on-surface-variant">GST ({Number(gstPercent) || 0}%)</dt>
            <dd className="text-on-surface">{money(b.gst)}</dd>
          </div>
          <div className="flex justify-between border-t border-outline-variant/40 pt-2 mt-2 font-semibold">
            <dt className="text-on-surface">Total</dt>
            <dd className="text-primary">{money(result?.finalPrice)}</dd>
          </div>
        </dl>
      )}

      <p className="text-[11px] text-on-surface-variant mt-4">
        Recalculated from the live {metal} rate whenever it changes, so this is a
        preview at today's rate rather than a fixed price.
      </p>
    </div>
  );
};

export default PriceBreakdownPreview;
