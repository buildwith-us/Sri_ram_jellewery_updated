/**
 * Does a saved bag / wishlist line refer to this product?
 *
 * Saved lines store `productId || _id` — the human key ("p4", "gold-ring")
 * whenever the product has one, which every product does. The product card and
 * product page compared that against the Mongo `_id` (or the URL, which can be
 * either), so a saved piece never showed as saved, and clicking the heart again
 * re-added it instead of removing it (bug F1). Match on either key.
 *
 * @param {string} savedId  the line's productId
 * @param {{ _id?: string, productId?: string } | null | undefined} product
 */
export const isSameProduct = (savedId, product) => {
  if (!product || savedId == null || savedId === "") return false;
  const id = String(savedId);
  return [product.productId, product._id].some((key) => key != null && key !== "" && String(key) === id);
};

export default isSameProduct;
