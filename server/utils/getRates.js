import { GoldRate } from "../models/GoldRate.js";
import { isRateStale } from "./rateGuards.js";

export const getRates = async () => {
  const rates = await GoldRate.find().lean();
  const rateMap = {};
  for (const r of rates) {
    if (r.metalType) rateMap[r.metalType] = r.ratePerGram;
  }
  return rateMap;
};

/**
 * Rates plus the metadata needed to decide whether they can still be trusted.
 * Kept separate from getRates() so existing pricing callers are untouched.
 *
 * @returns {{ rateMap: Object, updatedAt: Object, staleMetals: string[] }}
 */
export const getRateStatus = async () => {
  const rates = await GoldRate.find().lean();
  const rateMap = {};
  const updatedAt = {};
  const staleMetals = [];

  for (const r of rates) {
    if (!r.metalType) continue;
    rateMap[r.metalType] = r.ratePerGram;
    updatedAt[r.metalType] = r.updatedAt || null;
    if (isRateStale(r.updatedAt)) staleMetals.push(r.metalType);
  }

  return { rateMap, updatedAt, staleMetals };
};

/**
 * Which metals in a basket cannot be priced right now: the rate is stale, or
 * there is no usable rate for that metal at all.
 *
 * A stale rate yields a confident, wrong number that the customer is then
 * charged. A missing rate is worse: computePrice has nothing to price from,
 * and the checkout routes used to fall back to the stored `price` — the
 * making charge — so a 50 g silver anklet sold for ₹250. Refusing is the safe
 * failure in both cases.
 *
 * Quote-only and weightless products are not priced from the rate, so they
 * are never affected.
 *
 * @param {Object[]} products
 * @param {{ rateMap: Object|null, staleMetals: string[] }} status
 *   Pass rateMap null to check staleness only.
 * @returns {string[]} affected metals
 */
export const findUnpriceableMetalsForProducts = (products, { rateMap, staleMetals }) => {
  const affected = new Set();
  for (const product of products) {
    if (!product || product.isQuoteOnly || !product.weight) continue;
    const metal = product.metalType || "gold";
    const missing = rateMap && !(rateMap[metal] > 0);
    if (missing || staleMetals.includes(metal)) affected.add(metal);
  }
  return [...affected];
};

/** Staleness only — kept for existing callers. */
export const findStaleMetalsForProducts = (products, staleMetals) =>
  findUnpriceableMetalsForProducts(products, { rateMap: null, staleMetals });

/** The 503 both checkout routes return when a metal cannot be priced. */
export const rateUnavailableMessage = (metals) =>
  `Our ${metals.join(" and ")} rate is being updated, so these items cannot be priced right now. Please try again shortly.`;
