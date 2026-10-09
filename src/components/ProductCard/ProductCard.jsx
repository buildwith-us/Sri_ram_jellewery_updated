import React from 'react';
import { isSameProduct } from "../../utils/productKey";
import { useNavigate } from 'react-router-dom';
import useAuthContext from '../../hooks/useAuthContext';
import useCart from '../../hooks/useCart';
import useWishlist from '../../hooks/useWishlist';
import useAxiosSecure from '../../hooks/useAxiosSecure';
import toast from 'react-hot-toast';
import { optimizeCloudinaryUrl } from '../../utils/cloudinaryImage';
import { useLoginGate } from '../../context/LoginGateContext';

const ProductCard = ({ product }) => {
  const navigate = useNavigate();
  const { user } = useAuthContext();
  const { refetch } = useCart();
  const [wishlistData, , refetchWishlist, addToWishlist] = useWishlist();
  const [axiosSecure] = useAxiosSecure();
  const { requireLogin } = useLoginGate();
  
  const presentInWishlist = wishlistData?.some((item) => isSameProduct(item.productId, product));

  const handleCardClick = () => {
    navigate(`/products/${product._id}/description`);
  };

  return (
    <article className="group flex flex-col gap-5 cursor-pointer" onClick={handleCardClick}>
      <div className="relative aspect-[4/5] bg-surface-container-low overflow-hidden border border-gold/30 group-hover:border-gold/60 transition-colors duration-200 ease-out rounded-sm">
        {/* 200ms, not 700ms. This is the most-hovered element in the app —
            every card in every grid — and at 700ms the image was still
            settling long after the cursor had moved on, which reads as lag
            rather than elegance. */}
        <img
          alt={product.name}
          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200 ease-out"
          src={optimizeCloudinaryUrl(product.images?.[0] || product.img, { width: 500 }) || "https://placehold.co/400x500"}
        />
        <button 
          onClick={(e) => {
            e.stopPropagation();
            if (!user) {
              // The old getElementById("takeToLoginModal") call only worked on
              // the product detail page, so this silently did nothing here.
              requireLogin({
                message: "Sign in to save this piece to your wishlist \u2014 we'll save it for you right after.",
                intent: { type: "wishlist", productId: product._id },
              });
              return;
            }
            if (presentInWishlist) {
              const wishlistItem = wishlistData.find((item) => isSameProduct(item.productId, product));
              axiosSecure.delete(`/wishlist/${wishlistItem._id}`).then(() => {
                toast.success("Removed from wishlist");
                refetchWishlist();
              });
            } else {
              addToWishlist(product);
            }
          }}
          className={`absolute top-4 right-4 transition-colors z-10 p-2 rounded-full backdrop-blur-sm duration-300 ${
            presentInWishlist 
              ? 'bg-primary/10 text-primary opacity-100' 
              : 'bg-white/60 text-on-surface-variant hover:text-primary opacity-0 group-hover:opacity-100'
          }`}
        >
          <span className="material-symbols-outlined text-[20px]" style={{ fontVariationSettings: presentInWishlist ? "'FILL' 1" : "'FILL' 0" }}>
            favorite
          </span>
        </button>
      </div>
      
      <div className="flex flex-col items-center text-center gap-2">
        <span className="font-label-caps text-[10px] text-outline uppercase tracking-widest">
          {product.category || 'Heritage Gold'}
        </span>
        <h3 className="font-display-lg text-[22px] text-on-background leading-tight line-clamp-1 px-4">
          {product.name}
        </h3>
        
        <div className="mt-2 text-primary font-bold">
          {product.isQuoteOnly ? (
            <span className="italic text-outline text-sm">Quote</span>
          ) : product.price ? (
            `₹ ${product.price.toLocaleString("en-IN")}`
          ) : (
            <span className="italic text-outline text-sm">Dynamic</span>
          )}
        </div>
        
        <button 
          onClick={(e) => {
             e.stopPropagation();
             handleCardClick(); // For now just go to detail, can be Add to Cart later
          }}
          className="mt-2 font-button-text text-button-text text-primary border border-primary/40 px-8 py-2.5 hover:bg-primary hover:text-on-primary transition-ui duration-300 rounded-sm w-full max-w-[200px]"
        >
          View Details
        </button>
      </div>
    </article>
  );
};

export default ProductCard;
