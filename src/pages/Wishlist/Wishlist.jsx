import React from "react";
import useWishlist from "../../hooks/useWishlist";
import { Link } from "react-router-dom";
import useCart from "../../hooks/useCart";
import Swal from "sweetalert2";
import useProducts from "../../hooks/useProducts";
import useAxiosSecure from "../../hooks/useAxiosSecure";

const Wishlist = () => {
  const [wishlistData, isWishlistLoading, refetch] = useWishlist();
  const { cartData, addToCart, refetch: cartRefetch } = useCart();
  const [products] = useProducts();
  const [axiosSecure] = useAxiosSecure();

  const handleExistInCart = (productId) => {
    return cartData?.some((p) => p.productId == productId);
  };

  const handleAddToCart = (item) => {
    if (item) {
      addToCart(item);
      cartRefetch();
    }
  };

  const handleDeleteFromWishlist = (wishlistId) => {
    Swal.fire({
      title: "Are you sure?",
      text: "This piece will be removed from your wishlist.",
      icon: "question",
      showCancelButton: true,
      confirmButtonColor: "#8B6447",
      cancelButtonColor: "#c8a684",
      confirmButtonText: "Yes, remove it!",
    }).then((result) => {
      if (result.isConfirmed) {
        axiosSecure
          .delete(`/wishlist/${wishlistId}`)
          .then((res) => {
            if (res.data.deletedCount > 0) {
              Swal.fire({
                title: "Removed",
                text: "The piece has been removed from your wishlist.",
                icon: "success",
                confirmButtonColor: "#8B6447"
              });
              refetch();
            }
          })
          .catch((e) => console.error(e));
      }
    });
  };

  const getProductDetails = (productId) => {
    return products?.find((p) => p._id === productId) || {};
  };

  return (
    <div className="w-full">
      <header className="mb-12">
        <span className="font-label-caps text-label-caps text-secondary tracking-[0.2em] uppercase block mb-2">
          YOUR FAVORITES
        </span>
        <h1 className="font-display-lg text-display-lg text-primary">Wishlist</h1>
      </header>

      {isWishlistLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-gutter">
          {Array.from({ length: 4 }).map((_, idx) => (
            <div key={idx} className="bg-surface-variant h-[400px] w-full rounded-sm animate-pulse"></div>
          ))}
        </div>
      ) : (
        <>
          {wishlistData?.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-gutter">
              {wishlistData.map((item) => {
                const productDetails = getProductDetails(item.productId);
                const isQuoteOnly = productDetails.isQuoteOnly;
                // The server marks saved pieces the owner has switched off or
                // removed. They stay here, but say so plainly instead of
                // linking to a page that no longer exists.
                const unavailable = item.available === false;
                const productLink = (children) =>
                  unavailable ? children : <Link to={`/products/${item.productId}/description`}>{children}</Link>;
                
                return (
                  <div key={item._id} className="group relative flex flex-col h-full bg-surface-container border border-sand/30 overflow-hidden transition-ui duration-500 hover:shadow-[0_20px_40px_-10px_rgba(139,100,71,0.08)] hover:border-primary-container/60 hover:-translate-y-1">
                    <div className="aspect-[4/5] overflow-hidden relative">
                      {productLink(
                        <img
                          src={item.img}
                          alt={item.name}
                          className={`w-full h-full object-cover transition-transform duration-700 ease-out group-hover:scale-110 ${unavailable ? "opacity-50 grayscale" : ""}`}
                        />
                      )}
                      {unavailable && (
                        <span className="absolute left-4 top-4 px-3 py-1 bg-inverse-surface text-inverse-on-surface font-label-caps text-[10px] uppercase tracking-widest">
                          No longer available
                        </span>
                      )}
                      <button
                        className="absolute top-4 right-4 z-10 w-10 h-10 bg-white/80 backdrop-blur-sm rounded-full flex items-center justify-center text-primary transition-ui duration-300 hover:bg-white hover:scale-110 cursor-pointer"
                        onClick={() => handleDeleteFromWishlist(item._id)}
                        aria-label="Remove from Wishlist"
                      >
                        <span className="material-symbols-outlined" style={{ fontVariationSettings: "'FILL' 1" }}>favorite</span>
                      </button>
                    </div>

                    <div className="p-6 flex flex-col flex-grow text-center">
                      <span className="font-label-caps text-[10px] text-on-surface-variant uppercase mb-1">
                        {productDetails.category || "Collection"}
                      </span>
                      {productLink(
                        <h3 className="font-headline-sm text-headline-sm text-primary mb-1 hover:text-secondary line-clamp-1">{item.name}</h3>
                      )}
                      
                      <p className="font-body-base text-sm text-on-surface-variant mb-4">
                        {productDetails.carate ? `${productDetails.carate}K Gold` : " "}
                      </p>
                      
                      {!isQuoteOnly && !unavailable && (
                        <p className="font-headline-sm text-primary mt-auto mb-6">
                          ₹{item.discountPrice || item.price}
                        </p>
                      )}

                      <div className="space-y-3 mt-auto">
                        {unavailable ? (
                          <p className="w-full py-3 border border-outline-variant text-on-surface-variant font-button-text text-button-text uppercase" role="note">
                            This piece is no longer available
                          </p>
                        ) : isQuoteOnly ? (
                          <Link to={`/products/${item.productId}/description`} className="block w-full">
                            <button className="w-full py-3 border border-outline-variant text-primary font-button-text text-button-text hover:bg-surface-variant transition-colors cursor-pointer uppercase">
                              GET QUOTE
                            </button>
                          </Link>
                        ) : handleExistInCart(item.productId) ? (
                          <button disabled className="w-full py-3 bg-surface-variant text-on-surface-variant font-button-text text-button-text opacity-80 cursor-not-allowed uppercase">
                            ADDED TO BAG
                          </button>
                        ) : (
                          <button
                            onClick={() => handleAddToCart(item)}
                            className="w-full py-3 bg-primary-container text-on-primary font-button-text text-button-text hover:scale-[1.02] transition-transform flex items-center justify-center uppercase cursor-pointer"
                          >
                            ADD TO BAG
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-20 text-center animate-in fade-in border border-sand/30 bg-surface-container/30">
              <div className="mb-6 opacity-60">
                <span className="material-symbols-outlined text-[48px] text-primary" style={{ fontVariationSettings: "'wght' 200" }}>auto_awesome</span>
              </div>
              <h3 className="font-headline-sm text-headline-sm text-on-surface mb-2">Awaiting Inspiration</h3>
              <p className="font-body-base text-on-surface-variant max-w-md mb-8">Discover our meticulously curated collections and find pieces that resonate with your unique story.</p>
              <Link to="/shop">
                <button className="px-12 py-4 border border-outline-variant text-primary font-button-text text-button-text hover:bg-surface-variant transition-ui duration-500 cursor-pointer uppercase tracking-widest text-[11px]">
                  BROWSE COLLECTION
                </button>
              </Link>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default Wishlist;
