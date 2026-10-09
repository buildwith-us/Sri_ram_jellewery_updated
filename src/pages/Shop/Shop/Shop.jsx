import React, { useState } from 'react';
import CustomHelmet from '../../../components/CustomHelmet/CustomHelmet';
import useProducts from '../../../hooks/useProducts';
import { useSearchParams } from 'react-router-dom';
import ProductCard from '../../../components/ProductCard/ProductCard';
import useCategories from '../../../hooks/useCategories';
import { ProductCardSkeleton } from '../../../components/Skeleton/Skeleton';

const Shop = () => {
  const [products, isProductsLoading] = useProducts();
  const { categories } = useCategories();
  const [searchParams, setSearchParams] = useSearchParams();
  
  const categoryParam = searchParams.get('category');
  const metalParam = searchParams.get('metal');
  const priceParam = searchParams.get('price');
  const sortParam = searchParams.get('sort') || 'featured';
  const [searchTerm, setSearchTerm] = useState('');
  const [openFilter, setOpenFilter] = useState(null); // 'metal' | 'category' | 'price' | 'sort' | null

  const toggleFilter = (key) => setOpenFilter((prev) => (prev === key ? null : key));
  const closeFilter = () => setOpenFilter(null);

  const handleParamChange = (key, value) => {
    const newParams = new URLSearchParams(searchParams);
    if (value) {
      newParams.set(key, value);
    } else {
      newParams.delete(key);
    }
    setSearchParams(newParams);
  };

  // Quote-only pieces are priced on request and carry no number, so they can
  // neither satisfy nor fail a numeric range. Left to `undefined >= 50000` every
  // comparison returns false and they leaked into all three brackets at once.
  const priceOf = (p) => {
    const value = p.discountPrice ?? p.price;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };

  const timeOf = (p) => {
    const t = new Date(p.addedAt || 0).getTime();
    return Number.isNaN(t) ? 0 : t;
  };

  // Newest first, used on its own and as the tie-break for `featured` so equally
  // ranked products keep a stable order between renders.
  const byNewest = (a, b) => timeOf(b) - timeOf(a);

  const filteredProducts = products?.filter(p => {
    if (categoryParam && p.category?.toLowerCase() !== categoryParam.toLowerCase()) return false;
    if (metalParam && p.metalType?.toLowerCase() !== metalParam.toLowerCase()) return false;
    if (searchTerm && !p.name.toLowerCase().includes(searchTerm.toLowerCase())) return false;

    const productPrice = priceOf(p);

    // Price-on-request is its own bracket rather than a member of every one.
    if (priceParam === 'on_request') return productPrice === null;
    if (priceParam && productPrice === null) return false;

    if (priceParam === 'under50k' && productPrice >= 50000) return false;
    if (priceParam === '50k-1l' && (productPrice < 50000 || productPrice > 100000)) return false;
    if (priceParam === 'over1l' && productPrice <= 100000) return false;

    return true;
  }) || [];

  const PRICE_LABELS = {
    under50k: "Under ₹50k",
    "50k-1l": "₹50k – ₹1L",
    over1l: "Over ₹1L",
    on_request: "Price on Request",
  };

  // Every filter currently narrowing the list, each individually removable.
  const activeFilters = [
    metalParam && { key: "metal", label: metalParam },
    categoryParam && { key: "category", label: categoryParam },
    priceParam && { key: "price", label: PRICE_LABELS[priceParam] || priceParam },
  ].filter(Boolean);

  const clearAllFilters = () => {
    const next = new URLSearchParams(searchParams);
    ["metal", "category", "price"].forEach((k) => next.delete(k));
    setSearchParams(next); // sort is a display preference, not a filter — keep it
  };

  const sortedProducts = (() => {
    const items = [...filteredProducts];

    if (sortParam === 'price_low_high' || sortParam === 'price_high_low') {
      // Partition first so a null price never reaches the comparator as NaN.
      const priced = items.filter((p) => priceOf(p) !== null);
      const onRequest = items.filter((p) => priceOf(p) === null);
      priced.sort((a, b) =>
        sortParam === 'price_low_high'
          ? priceOf(a) - priceOf(b)
          : priceOf(b) - priceOf(a)
      );
      // Unpriced pieces trail the list in both directions — they have no rank.
      return [...priced, ...onRequest.sort(byNewest)];
    }

    if (sortParam === 'newest') return items.sort(byNewest);

    return items.sort(
      (a, b) => Number(Boolean(b.featured)) - Number(Boolean(a.featured)) || byNewest(a, b)
    );
  })();

  return (
    <div className="font-body-base bg-background text-on-surface min-h-screen pb-20">
      <CustomHelmet title="Shop All" />

      {/* Main Content */}
      <main className="max-w-container-max mx-auto px-margin-mobile md:px-margin-desktop py-12 md:py-16 flex flex-col gap-12 mt-[72px]">
        {/* Header Area: Breadcrumbs & Title */}
        <section className="flex flex-col items-center text-center gap-3">
          <nav className="font-body-base text-[13px] text-on-surface-variant">
            <a className="hover:text-primary transition-colors inline-flex items-center min-h-11" href="/">Home</a>
            <span className="mx-2 text-outline-variant">/</span>
            <a className="hover:text-primary transition-colors inline-flex items-center min-h-11" href="/shop">Collections</a>
            <span className="mx-2 text-outline-variant">/</span>
            <span className="text-primary font-medium">All Jewellery</span>
          </nav>
          <div className="relative inline-block mt-2">
            <h1 className="font-display-lg text-[48px] md:text-display-lg text-primary">
              {categoryParam ? categoryParam.toUpperCase() : "The Collection"}
            </h1>
            <div className="absolute -bottom-3 left-1/4 right-1/4 h-[1px] bg-secondary-fixed-dim/50"></div>
          </div>
        </section>

        {/* Filter Bar */}
        <section className="relative flex flex-col md:flex-row justify-between items-center border-y border-outline-variant/30 py-6 gap-6 bg-surface-container-low/30 px-6">
          {/* On a phone the three triggers don't fit on one line. The row used
              to scroll sideways, which left Price past the screen edge with
              its menu opening further off it (M1). It wraps instead, and each
              menu hangs from the row's left edge (the triggers are only
              positioning parents from md up), so no menu can leave the
              screen. A scroll container is avoided on purpose: it would clip
              the absolutely positioned menus. Stacked above Sort (z-30), which
              follows it, and below the sticky header (z-40). */}
          <div className="relative z-[35] flex flex-wrap gap-x-8 gap-y-1 w-full pb-2 md:pb-0">

            {/* Metal Filter */}
            <div className="md:relative">
              <button
                onClick={() => toggleFilter('metal')}
                className="flex items-center gap-4 min-h-11 font-label-caps text-label-caps text-on-surface uppercase tracking-widest hover:text-primary transition-colors"
              >
                Metal <span className="material-symbols-outlined text-sm">expand_more</span>
              </button>
              {openFilter === 'metal' && (
                <div className="absolute top-full left-0 mt-2 bg-surface border border-outline-variant/30 p-2 z-30 whitespace-nowrap shadow-sm">
                  <button onClick={() => { handleParamChange('metal', null); closeFilter(); }} className="block w-full text-left px-4 py-2 hover:bg-surface-container font-label-caps text-xs text-on-surface uppercase">ALL</button>
                  <button onClick={() => { handleParamChange('metal', 'gold'); closeFilter(); }} className="block w-full text-left px-4 py-2 hover:bg-surface-container font-label-caps text-xs text-on-surface uppercase">Gold</button>
                  <button onClick={() => { handleParamChange('metal', 'silver'); closeFilter(); }} className="block w-full text-left px-4 py-2 hover:bg-surface-container font-label-caps text-xs text-on-surface uppercase">Silver</button>
                </div>
              )}
            </div>

            {/* Category Filter */}
            <div className="md:relative">
              <button
                onClick={() => toggleFilter('category')}
                className="flex items-center gap-4 min-h-11 font-label-caps text-label-caps text-on-surface uppercase tracking-widest hover:text-primary transition-colors"
              >
                Category <span className="material-symbols-outlined text-sm">expand_more</span>
              </button>
              {openFilter === 'category' && (
                <div className="absolute top-full left-0 mt-2 bg-surface border border-outline-variant/30 p-2 z-30 whitespace-nowrap shadow-sm max-h-64 overflow-y-auto">
                  <button
                    onClick={() => { handleParamChange('category', null); closeFilter(); }}
                    className="block w-full text-left px-4 py-2 hover:bg-surface-container font-label-caps text-xs text-on-surface"
                  >
                    ALL
                  </button>
                  {categories?.map(c => (
                    <button
                      key={c._id}
                      onClick={() => { handleParamChange('category', c.categoryName?.toLowerCase()); closeFilter(); }}
                      className="block w-full text-left px-4 py-2 hover:bg-surface-container font-label-caps text-xs text-on-surface uppercase"
                    >
                      {c.categoryName}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Price Filter */}
            <div className="md:relative">
              <button
                onClick={() => toggleFilter('price')}
                className="flex items-center gap-4 min-h-11 font-label-caps text-label-caps text-on-surface uppercase tracking-widest hover:text-primary transition-colors"
              >
                Price <span className="material-symbols-outlined text-sm">expand_more</span>
              </button>
              {openFilter === 'price' && (
                <div className="absolute top-full left-0 mt-2 bg-surface border border-outline-variant/30 p-2 z-30 whitespace-nowrap shadow-sm">
                  <button onClick={() => { handleParamChange('price', null); closeFilter(); }} className="block w-full text-left px-4 py-2 hover:bg-surface-container font-label-caps text-xs text-on-surface uppercase">ALL</button>
                  <button onClick={() => { handleParamChange('price', 'under50k'); closeFilter(); }} className="block w-full text-left px-4 py-2 hover:bg-surface-container font-label-caps text-xs text-on-surface uppercase">Under ₹50k</button>
                  <button onClick={() => { handleParamChange('price', '50k-1l'); closeFilter(); }} className="block w-full text-left px-4 py-2 hover:bg-surface-container font-label-caps text-xs text-on-surface uppercase">₹50k - ₹1L</button>
                  <button onClick={() => { handleParamChange('price', 'over1l'); closeFilter(); }} className="block w-full text-left px-4 py-2 hover:bg-surface-container font-label-caps text-xs text-on-surface uppercase">Over ₹1L</button>
                  <button onClick={() => { handleParamChange('price', 'on_request'); closeFilter(); }} className="block w-full text-left px-4 py-2 hover:bg-surface-container font-label-caps text-xs text-on-surface uppercase">Price on Request</button>
                </div>
              )}
            </div>
          </div>

          {/* Sort By Dropdown */}
          <div className="flex items-center gap-2 font-label-caps text-[11px] text-on-surface-variant whitespace-nowrap relative z-30 cursor-pointer">
            <span className="uppercase tracking-widest">Sort by:</span>
            <button
              onClick={() => toggleFilter('sort')}
              className="flex items-center gap-1 min-h-11 text-primary hover:text-primary-container transition-colors font-bold uppercase tracking-widest"
            >
              {sortParam === 'newest' ? 'Newest' : sortParam === 'price_low_high' ? 'Price: Low to High' : sortParam === 'price_high_low' ? 'Price: High to Low' : 'Featured'}
              <span className="material-symbols-outlined text-sm">sort</span>
            </button>
            {openFilter === 'sort' && (
              <div className="absolute top-full right-0 mt-2 bg-surface border border-outline-variant/30 p-2 z-30 whitespace-nowrap shadow-sm">
                <button onClick={() => { handleParamChange('sort', 'featured'); closeFilter(); }} className="block w-full text-left px-4 py-2 hover:bg-surface-container font-label-caps text-xs text-on-surface uppercase">Featured</button>
                <button onClick={() => { handleParamChange('sort', 'newest'); closeFilter(); }} className="block w-full text-left px-4 py-2 hover:bg-surface-container font-label-caps text-xs text-on-surface uppercase">Newest</button>
                <button onClick={() => { handleParamChange('sort', 'price_low_high'); closeFilter(); }} className="block w-full text-left px-4 py-2 hover:bg-surface-container font-label-caps text-xs text-on-surface uppercase">Price: Low to High</button>
                <button onClick={() => { handleParamChange('sort', 'price_high_low'); closeFilter(); }} className="block w-full text-left px-4 py-2 hover:bg-surface-container font-label-caps text-xs text-on-surface uppercase">Price: High to Low</button>
              </div>
            )}
          </div>

          {/* Backdrop to close an open dropdown on outside tap/click */}
          {openFilter && (
            <div className="fixed inset-0 z-20" onClick={closeFilter}></div>
          )}
        </section>

        {/* Result count and active filters. The empty state already offered a
            way out; this makes the count and the escape hatch visible while
            results are still showing, so a narrow filter is obvious. */}
        {!isProductsLoading && (
          <div className="flex flex-wrap items-center justify-between gap-4 mb-8">
            <p className="font-label-caps text-[11px] uppercase tracking-[0.2em] text-on-surface-variant">
              {sortedProducts.length === products?.length
                ? `${sortedProducts.length} pieces`
                : `${sortedProducts.length} of ${products?.length ?? 0} pieces`}
            </p>

            {activeFilters.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                {activeFilters.map(({ key, label }) => (
                  <button
                    key={key}
                    onClick={() => handleParamChange(key, null)}
                    className="inline-flex items-center gap-1.5 min-h-11 px-3 border border-outline-variant/40 text-on-surface-variant hover:text-primary hover:border-primary transition-colors font-label-caps text-[11px] uppercase tracking-[0.1em]"
                  >
                    {label}
                    <span className="material-symbols-outlined text-[14px]">close</span>
                  </button>
                ))}
                <button
                  onClick={clearAllFilters}
                  className="inline-flex items-center min-h-11 px-3 text-primary hover:text-secondary transition-colors font-label-caps text-[11px] uppercase tracking-[0.1em] underline underline-offset-4"
                >
                  Clear all
                </button>
              </div>
            )}
          </div>
        )}

        {/* Product Grid */}
        {isProductsLoading ? (
          <section className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-x-8 gap-y-16">
            {/* Shaped like the real card — image, category, name, price — so
                nothing shifts when data lands. The blocks this replaced were
                image-only, so every tile jumped once its text appeared. */}
            {Array.from({ length: 8 }).map((_, i) => (
              <ProductCardSkeleton key={i} />
            ))}
          </section>
        ) : sortedProducts.length > 0 ? (
          <section className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-x-8 gap-y-16">
            {sortedProducts.map(product => (
              <ProductCard key={product._id} product={product} />
            ))}
          </section>
        ) : (
          <div className="py-20 text-center flex flex-col items-center border border-outline-variant/20 bg-surface-container-low/20">
            <span className="material-symbols-outlined text-4xl text-outline-variant mb-4">inventory_2</span>
            <h2 className="font-display-lg text-headline-sm text-primary mb-2">No Results Found</h2>
            <p className="font-body-base text-on-surface-variant max-w-md">
              We couldn't find any pieces matching your current filters. Please try clearing them.
            </p>
            <button 
              onClick={() => { setSearchParams({}); setSearchTerm(''); }}
              className="mt-6 px-6 py-3 border border-primary text-primary hover:bg-primary hover:text-white transition-colors font-button-text uppercase tracking-widest text-xs rounded-sm"
            >
              Clear All Filters
            </button>
          </div>
        )}
      </main>
    </div>
  );
};

export default Shop;
