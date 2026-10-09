import React, { useEffect, useState } from "react";
import { useQuery } from "react-query";
import { useParams, Link, useNavigate } from "react-router-dom";
import useCart from "../../hooks/useCart";
import useAuthContext from "../../hooks/useAuthContext";
import useWishlist from "../../hooks/useWishlist";
import CustomHelmet from "../../components/CustomHelmet/CustomHelmet";
import useAxiosSecure from "../../hooks/useAxiosSecure";
import toast from "react-hot-toast";
import ImageZoomLens from "../../components/ImageZoomLens/ImageZoomLens";
import { optimizeCloudinaryUrl } from "../../utils/cloudinaryImage";
import { useLoginGate } from "../../context/LoginGateContext";
import { useRegisterDialog } from "../../utils/dialogRegistry";
import useTrackProductView from "../../hooks/useTrackProductView";

const DynamicProduct = () => {
  const { id } = useParams();
  useTrackProductView(id);
  const { user } = useAuthContext();
  const [presentInCart, setPresentInCart] = useState(false);
  const [presentInWishlist, setPresentInWishlist] = useState(false);
  const { cartData, addToCart } = useCart();
  const [wishlistData, , refetchWishlist, addToWishlist] = useWishlist();
  const navigate = useNavigate();
  const [axiosSecure] = useAxiosSecure();
  const { requireLogin } = useLoginGate();
  const [activeImageIndex, setActiveImageIndex] = useState(0);
  const [quantity, setQuantity] = useState(1);
  const [isQuoteModalOpen, setIsQuoteModalOpen] = useState(false);
  const [quoteName, setQuoteName] = useState("");
  const [quoteMobile, setQuoteMobile] = useState("");
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [isImageZoomed, setIsImageZoomed] = useState(false);
  const [isImageModalOpen, setIsImageModalOpen] = useState(false);
  // Both dialogs on this page tell the registry when they are open, so the
  // timed sign-in prompt never appears on top of them.
  useRegisterDialog("quote-modal", isQuoteModalOpen);
  useRegisterDialog("image-zoom", isImageModalOpen);

  // Fetch this one product by id rather than pulling the whole catalogue and
  // filtering client-side. The old approach matched only on `_id`, so a URL
  // carrying the equally valid `productId` (which the API itself accepts) found
  // nothing and left the page on a spinner forever.
  const {
    data: dynamicProduct,
    isLoading: isProductLoading,
    error: productError,
  } = useQuery({
    queryKey: ["product", id],
    enabled: Boolean(id),
    retry: (failureCount, err) =>
      // A 404 is a real answer, not a blip — retrying it only delays the
      // not-found state the customer needs to see.
      err?.response?.status === 404 ? false : failureCount < 2,
    queryFn: async () => {
      const res = await axiosSecure.get(`/products/${id}`);
      return res.data?.data ?? res.data;
    },
  });

  // Navigating to a different product must not keep the previous selection.
  useEffect(() => {
    setActiveImageIndex(0);
    setQuantity(1);
  }, [id]);

  useEffect(() => {
    if (user) {
      const cartProduct = cartData?.find((cartItem) => cartItem.productId === id);
      setPresentInCart(!!cartProduct);

      const wishlistProduct = wishlistData?.find((wishlistItem) => wishlistItem.productId === id);
      setPresentInWishlist(!!wishlistProduct);
    }
  }, [cartData, dynamicProduct, id, wishlistData, user]);

  const handleAddToCartWishlist = (where) => {
    if (user) {
      if (where === "cart") {
        addToCart(dynamicProduct, quantity);
      } else if (where === "wishlist") {
        if (presentInWishlist) {
          const wishlistItem = wishlistData.find(item => item.productId === id);
          if (wishlistItem) {
            axiosSecure.delete(`/wishlist/${wishlistItem._id}`).then(() => {
              import('react-hot-toast').then(({ default: toast }) => {
                toast.success("Removed from wishlist");
                refetchWishlist();
              });
            });
          }
        } else {
          addToWishlist(dynamicProduct);
        }
      }
    } else {
      requireLogin({
        message:
          where === "cart"
            ? "Sign in to add this piece to your bag \u2014 we'll add it for you right after."
            : "Sign in to save this piece to your wishlist \u2014 we'll save it for you right after.",
        intent: { type: where, productId: dynamicProduct._id, quantity },
      });
    }
  };

  // Buy Now bypasses the cart entirely: the chosen product/quantity is handed
  // straight to checkout via router state (the server re-verifies pricing).
  const handleBuyNow = () => {
    if (!user) {
      requireLogin({
        message: "Sign in to complete your purchase \u2014 we'll take you straight to checkout.",
        intent: { type: "buyNow", productId: dynamicProduct._id, quantity },
      });
      return;
    }
    navigate("/checkout", {
      state: {
        buyNow: {
          productId: dynamicProduct.productId || dynamicProduct._id,
          name: dynamicProduct.name,
          img: dynamicProduct.img || dynamicProduct.images?.[0],
          image: dynamicProduct.image,
          category: dynamicProduct.category,
          price: dynamicProduct.discountPrice || dynamicProduct.price,
          // Carried through so checkout can show the GST already inside that
          // price. Nothing is billed from it — the server recomputes every
          // figure on the order — it exists so the summary can itemise.
          gstPercent: dynamicProduct.gstPercent,
          quantity,
        },
      },
    });
  };

  const handleQuoteRequest = async (e) => {
    e.preventDefault();
    if (!user) {
      toast.error("Please login to request a quote.");
      navigate("/login", { state: { from: location } });
      return;
    }
    setQuoteLoading(true);
    try {
      await axiosSecure.post("/quotes", {
        productId: dynamicProduct.productId || dynamicProduct._id,
        productName: dynamicProduct.name,
        productImage: dynamicProduct.img,
        customerName: quoteName,
        customerMobile: quoteMobile,
        isQuoteOnly: dynamicProduct.isQuoteOnly || false,
      });
      alert("Quote requested! Our artisans will contact you via WhatsApp shortly.");
      setIsQuoteModalOpen(false);
    } catch (error) {
      console.error(error);
      alert("Failed to submit quote request. Please try again.");
    } finally {
      setQuoteLoading(false);
    }
  };

  if (isProductLoading) {
    return (
      <div className="w-full flex justify-center items-center py-40 bg-surface">
        <span className="loading loading-spinner loading-lg text-primary"></span>
      </div>
    );
  }

  // Anything that is not a loaded product ends here rather than spinning
  // indefinitely: a 404, a failed request, or a response with no product in it.
  if (productError || !dynamicProduct) {
    const isMissing = productError?.response?.status === 404 || !productError;
    return (
      <div className="w-full bg-surface py-40 px-margin-mobile md:px-margin-desktop">
        <CustomHelmet title={isMissing ? "Piece not found" : "Something went wrong"} />
        <div className="max-w-md mx-auto text-center">
          <span className="material-symbols-outlined text-5xl text-on-surface-variant/50">
            {isMissing ? "search_off" : "error"}
          </span>
          <h1 className="font-display-lg text-headline-md text-primary mt-6 mb-3">
            {isMissing ? "We couldn't find that piece" : "We couldn't load that piece"}
          </h1>
          <p className="text-on-surface-variant font-body-base mb-8">
            {isMissing
              ? "It may have been sold, renamed, or the link may be out of date."
              : "Something went wrong at our end. Please try again in a moment."}
          </p>
          <Link
            to="/shop"
            className="inline-block bg-primary text-on-primary px-8 py-3 font-button-text text-button-text tracking-wider uppercase hover:opacity-90 transition-ui"
          >
            Browse the collection
          </Link>
        </div>
      </div>
    );
  }

  const finalPrice = dynamicProduct.discountPrice || dynamicProduct.price;

  // Field names must match what computePrice actually returns — metalValue,
  // wastageValue, gst, ratePerGram. Reading materialCost/makingCharges (which
  // exist nowhere on the response) silently rendered ₹0 against the two largest
  // lines, so the itemisation shown to the customer did not sum to the total
  // they were asked to pay. PriceBreakdownPreview.jsx is the reference.
  const breakdown = dynamicProduct.priceBreakdown;
  const wastagePercent = Number(dynamicProduct.wastagePercent) || 0;
  const gstPercent = Number(dynamicProduct.gstPercent) || 0;

  // Gallery sources: every distinct image this product has, primary first.
  const galleryImages = [
    ...(dynamicProduct.images?.length ? dynamicProduct.images : []),
    dynamicProduct.img,
    dynamicProduct.image,
  ].filter((src, i, arr) => src && arr.indexOf(src) === i);

  const mainImage = galleryImages[activeImageIndex] || galleryImages[0];

  // Stock may be absent on legacy products; treat that as "not stock-tracked"
  // rather than out of stock, so those products stay purchasable.
  const hasStockField = typeof dynamicProduct.stock === "number";
  const isOutOfStock = hasStockField && dynamicProduct.stock <= 0;
  const maxQuantity = hasStockField && dynamicProduct.stock > 0 ? dynamicProduct.stock : 99;

  return (
    <div className="font-body-base bg-background text-on-surface min-h-screen">
      <CustomHelmet title={dynamicProduct.name || "Product Details"} />
      
      <main className="pt-32 pb-section-gap-lg max-w-container-max mx-auto px-margin-mobile md:px-margin-desktop">
        {/* Breadcrumb */}
        <nav className="mb-12">
          <ol className="flex items-center gap-2 text-label-caps font-label-caps text-on-surface-variant uppercase">
            <li><Link className="hover:text-primary transition-colors" to="/">Home</Link></li>
            <li className="flex items-center gap-2">
              <span className="material-symbols-outlined text-sm">chevron_right</span> 
              <Link className="hover:text-primary transition-colors" to="/shop">Shop</Link>
            </li>
            <li className="flex items-center gap-2 font-bold text-primary">
              <span className="material-symbols-outlined text-sm">chevron_right</span> 
              {dynamicProduct.category || 'Jewellery'}
            </li>
          </ol>
        </nav>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-16">
          {/* Left Column: Imagery */}
          <div className="lg:col-span-7 flex flex-col gap-6">
            <div className="bg-surface-container overflow-hidden border border-gold/30 aspect-square group relative rounded-sm">
              <ImageZoomLens
                src={optimizeCloudinaryUrl(mainImage, { width: 800 }) || "https://placehold.co/800x800"}
                alt={dynamicProduct.name} 
                onClick={() => { setIsImageZoomed(false); setIsImageModalOpen(true); document.getElementById('imageModal').showModal(); }}
              />
              <button 
                onClick={() => { setIsImageZoomed(false); setIsImageModalOpen(true); document.getElementById('imageModal').showModal(); }}
                className="absolute top-4 right-4 bg-white/80 p-2 rounded-full backdrop-blur-sm hover:bg-white transition-colors"
              >
                <span className="material-symbols-outlined text-primary">zoom_in</span>
              </button>
            </div>
            
            {galleryImages.length > 1 && (
              <div className="grid grid-cols-3 gap-6">
                {galleryImages.map((imgSrc, idx) => (
                  <button
                    key={imgSrc}
                    type="button"
                    onClick={() => setActiveImageIndex(idx)}
                    aria-label={`View image ${idx + 1} of ${galleryImages.length}`}
                    aria-current={idx === activeImageIndex}
                    className={`bg-surface-container border aspect-square overflow-hidden cursor-pointer group rounded-sm transition-colors ${
                      idx === activeImageIndex
                        ? "border-primary border-2"
                        : "border-gold/30 hover:border-gold"
                    }`}
                  >
                    <img
                      alt={`${dynamicProduct.name} view ${idx + 1}`}
                      className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                      src={optimizeCloudinaryUrl(imgSrc, { width: 300 })}
                      onError={(e) => { e.target.src = "https://placehold.co/400x400?text=Image+Not+Found"; }}
                    />
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Right Column: Product Info */}
          <div className="lg:col-span-5">
            <div className="lg:sticky lg:top-40">
              <p className="font-label-caps text-label-caps text-primary tracking-widest mb-4 uppercase">
                {dynamicProduct.category || 'Jewellery'}
              </p>
              <h1 className="font-display-lg text-headline-md text-on-surface mb-8 leading-tight">
                {dynamicProduct.name}
              </h1>
              
              {/* Price Table */}
              {dynamicProduct.isQuoteOnly ? (
                <div className="bg-surface-container-lowest p-8 border border-outline-variant/30 mb-8 rounded-sm text-center">
                  <h3 className="font-button-text text-button-text text-primary mb-2 tracking-wider">PRICE ON REQUEST</h3>
                  <p className="text-on-surface-variant font-body-base">
                    Contact us for a personalized quote.
                  </p>
                </div>
              ) : (
                <div className="bg-surface-container-lowest p-8 border border-outline-variant/30 mb-8 rounded-sm">
                  <h3 className="font-button-text text-button-text text-primary mb-6 tracking-wider border-b border-outline-variant/20 pb-2">PRICE BREAKDOWN</h3>
                  <div className="space-y-4">
                    {breakdown ? (
                      <>
                        <div className="flex justify-between items-center">
                          <span className="text-on-surface-variant font-body-base">
                            Metal value
                            {dynamicProduct.weight ? ` (${dynamicProduct.weight}g × ₹${breakdown.ratePerGram?.toLocaleString("en-IN")}/g)` : ""}
                          </span>
                          <span className="font-semibold">₹ {(breakdown.metalValue ?? 0).toLocaleString("en-IN")}</span>
                        </div>
                        <div className="flex justify-between items-center">
                          <span className="text-on-surface-variant font-body-base">
                            Wastage{wastagePercent ? ` (${wastagePercent}%)` : ""}
                          </span>
                          <span className="font-semibold">₹ {(breakdown.wastageValue ?? 0).toLocaleString("en-IN")}</span>
                        </div>
                        <div className="flex justify-between items-center">
                          <span className="text-on-surface-variant font-body-base">
                            GST{gstPercent ? ` (${gstPercent}%)` : ""}
                          </span>
                          <span className="font-semibold">₹ {(breakdown.gst ?? 0).toLocaleString("en-IN")}</span>
                        </div>
                      </>
                    ) : (
                      <div className="flex justify-between items-center">
                        <span className="text-on-surface-variant font-body-base">Base Price</span>
                        <span className="font-semibold">₹ {finalPrice?.toLocaleString("en-IN") || 0}</span>
                      </div>
                    )}
                    <div className="pt-6 mt-6 border-t border-primary/20 flex justify-between items-center">
                      <span className="font-display-lg text-headline-sm text-primary uppercase">Net Payable</span>
                      <span className="font-display-lg text-headline-sm text-primary">₹ {finalPrice?.toLocaleString("en-IN") || 0}</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Actions */}
              <div className="flex flex-col gap-4 mb-12">
                {!dynamicProduct.isQuoteOnly && (
                  <>
                    {/* Quantity */}
                    <div className="flex items-center justify-between gap-4">
                      <span className="font-label-caps text-label-caps text-on-surface-variant uppercase tracking-widest">
                        Quantity
                      </span>
                      <div className="flex items-center border border-sand/50 rounded-sm">
                        <button
                          type="button"
                          onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                          disabled={quantity <= 1 || isOutOfStock}
                          aria-label="Decrease quantity"
                          className="w-11 h-11 flex items-center justify-center text-primary disabled:opacity-30 disabled:cursor-not-allowed hover:bg-primary/5 transition-colors"
                        >
                          <span className="material-symbols-outlined text-[18px]">remove</span>
                        </button>
                        <input
                          type="number"
                          value={quantity}
                          min={1}
                          max={maxQuantity}
                          aria-label="Quantity"
                          onChange={(e) => {
                            const n = parseInt(e.target.value, 10);
                            if (Number.isNaN(n)) return;
                            setQuantity(Math.min(Math.max(1, n), maxQuantity));
                          }}
                          disabled={isOutOfStock}
                          className="w-14 h-11 text-center bg-transparent border-x border-sand/50 font-body-base text-on-surface outline-none focus:bg-primary/5 disabled:opacity-40 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        />
                        <button
                          type="button"
                          onClick={() => setQuantity((q) => Math.min(maxQuantity, q + 1))}
                          disabled={quantity >= maxQuantity || isOutOfStock}
                          aria-label="Increase quantity"
                          className="w-11 h-11 flex items-center justify-center text-primary disabled:opacity-30 disabled:cursor-not-allowed hover:bg-primary/5 transition-colors"
                        >
                          <span className="material-symbols-outlined text-[18px]">add</span>
                        </button>
                      </div>
                    </div>

                    {typeof dynamicProduct.stock === "number" && (
                      <p className={`font-body-base text-sm -mt-2 ${isOutOfStock ? "text-error" : "text-on-surface-variant"}`}>
                        {isOutOfStock
                          ? "Currently out of stock."
                          : dynamicProduct.stock <= 5
                            ? `Only ${dynamicProduct.stock} left in stock.`
                            : `${dynamicProduct.stock} in stock.`}
                      </p>
                    )}

                    <button
                      onClick={handleBuyNow}
                      disabled={isOutOfStock}
                      className="w-full bg-primary text-white py-5 font-button-text text-button-text tracking-widest hover:brightness-110 active:scale-[0.98] transition-ui flex items-center justify-center gap-3 rounded-sm disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:brightness-100"
                    >
                      <span className="material-symbols-outlined text-sm">bolt</span>
                      BUY NOW
                    </button>

                    <button
                      onClick={() => handleAddToCartWishlist("cart")}
                      disabled={isOutOfStock}
                      className="w-full bg-primary-container text-white py-5 font-button-text text-button-text tracking-widest hover:brightness-110 active:scale-[0.98] transition-ui flex items-center justify-center gap-3 rounded-sm disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:brightness-100"
                    >
                      <span className="material-symbols-outlined text-sm">shopping_bag</span>
                      {presentInCart ? "ALREADY IN BAG" : "ADD TO BAG"}
                    </button>
                  </>
                )}
                <button 
                  onClick={() => setIsQuoteModalOpen(true)}
                  className="w-full bg-transparent border border-sand text-primary py-5 font-button-text text-button-text tracking-widest hover:bg-primary/5 active:scale-[0.98] transition-ui flex items-center justify-center gap-3 rounded-sm"
                >
                  <span className="material-symbols-outlined text-sm">mail</span>
                  ENQUIRE NOW
                </button>
              </div>

              {/* Accordion Details */}
              <div className="space-y-0">
                <details className="group border-b border-outline-variant/30 py-4" open>
                  <summary className="flex justify-between items-center cursor-pointer list-none font-button-text text-button-text text-on-surface">
                    DETAILS
                    <span className="material-symbols-outlined transition-transform group-open:rotate-180">expand_more</span>
                  </summary>
                  <div className="pt-4 pb-2 text-on-surface-variant text-body-base leading-relaxed">
                    {dynamicProduct.description || "Intricately designed jewellery piece crafted by artisans."}
                  </div>
                </details>
                <details className="group border-b border-outline-variant/30 py-4">
                  <summary className="flex justify-between items-center cursor-pointer list-none font-button-text text-button-text text-on-surface">
                    SHIPPING & RETURNS
                    <span className="material-symbols-outlined transition-transform group-open:rotate-180">expand_more</span>
                  </summary>
                  <div className="pt-4 pb-2 text-on-surface-variant text-body-base">
                    Complimentary fully insured shipping within India. Returns accepted within 7 days in original, unworn condition with all authenticity certificates.
                  </div>
                </details>
                <details className="group border-b border-outline-variant/30 py-4">
                  <summary className="flex justify-between items-center cursor-pointer list-none font-button-text text-button-text text-on-surface">
                    CARE GUIDE
                    <span className="material-symbols-outlined transition-transform group-open:rotate-180">expand_more</span>
                  </summary>
                  <div className="pt-4 pb-2 text-on-surface-variant text-body-base">
                    Store in a soft pouch to avoid scratches. Clean with a dry cotton cloth after each use. Professional polishing service available at any SRJ boutique.
                  </div>
                </details>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Quote Modal */}
      {isQuoteModalOpen && (
        <dialog id="quote_modal" className="modal modal-open">
          <div className="modal-box bg-surface border border-outline-variant/30 rounded-sm">
            <form method="dialog">
              <button
                aria-label="Close quote request"
                onClick={() => setIsQuoteModalOpen(false)}
                className="inline-flex items-center justify-center w-11 h-11 rounded-full text-on-surface hover:bg-surface-container transition-colors absolute right-2 top-2"
              >
                ✕
              </button>
            </form>
            <h3 className="font-display-lg text-headline-sm text-primary mb-4">Request Quote</h3>
            <p className="font-body-base text-on-surface-variant text-sm mb-6">
              Our artisans will prepare a personalized quote and contact you.
            </p>
            <form onSubmit={handleQuoteRequest} className="space-y-4">
              <div>
                <label className="block font-label-caps text-xs text-on-surface-variant uppercase tracking-wider mb-2">Name</label>
                <input 
                  type="text" 
                  value={quoteName}
                  onChange={(e) => setQuoteName(e.target.value)}
                  className="w-full bg-surface-container-low border border-outline-variant/50 px-4 py-3 text-sm focus:border-primary focus:ring-1 focus:ring-primary outline-none transition-ui rounded-sm"
                  placeholder="Your Full Name"
                  required 
                />
              </div>
              <div>
                <label className="block font-label-caps text-xs text-on-surface-variant uppercase tracking-wider mb-2">WhatsApp Number</label>
                <input 
                  type="tel" 
                  value={quoteMobile}
                  onChange={(e) => setQuoteMobile(e.target.value)}
                  className="w-full bg-surface-container-low border border-outline-variant/50 px-4 py-3 text-sm focus:border-primary focus:ring-1 focus:ring-primary outline-none transition-ui rounded-sm"
                  placeholder="+91"
                  required 
                />
              </div>
              <button 
                type="submit" 
                disabled={quoteLoading}
                className="w-full mt-4 bg-primary text-white py-4 font-button-text uppercase tracking-widest hover:bg-primary-container transition-colors disabled:opacity-70 rounded-sm"
              >
                {quoteLoading ? "Submitting..." : "Submit Request"}
              </button>
            </form>
          </div>
          <form method="dialog" className="modal-backdrop">
            <button onClick={() => setIsQuoteModalOpen(false)}>close</button>
          </form>
        </dialog>
      )}

      {/* Image Zoom Modal */}
      <dialog id="imageModal" className="modal" onClose={() => setIsImageModalOpen(false)}>
        <div className="modal-box w-11/12 max-w-5xl bg-surface p-2 rounded-sm relative overflow-hidden h-[80vh]">
          <form method="dialog">
            <button
              aria-label="Close zoomed image"
              className="inline-flex items-center justify-center w-11 h-11 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors absolute right-4 top-4 z-50"
            >
              ✕
            </button>
          </form>
          {/* The lens magnifier is pointer-only, so on a phone this modal is the
              entire zoom feature — and it was rendering the image at the same
              size as the page, i.e. no magnification at all. Tapping now
              toggles a 2.5x view that pans by scrolling. */}
          <div className={`w-full h-full ${isImageZoomed ? "overflow-auto" : "overflow-hidden"}`}>
            <img
              src={optimizeCloudinaryUrl(mainImage)}
              onClick={() => setIsImageZoomed((z) => !z)}
              className={
                isImageZoomed
                  ? "w-[250%] max-w-none h-auto cursor-zoom-out"
                  : "w-full h-full object-contain cursor-zoom-in"
              }
              alt="Zoomed Product"
            />
          </div>
          <span className="absolute bottom-3 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full bg-black/55 text-white text-[11px] font-label-caps uppercase tracking-[0.1em] pointer-events-none">
            {isImageZoomed ? "Tap image to fit · drag to pan" : "Tap image to zoom"}
          </span>
        </div>
        <form method="dialog" className="modal-backdrop">
          <button>close</button>
        </form>
      </dialog>

    </div>
  );
};

export default DynamicProduct;
