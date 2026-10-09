import React from "react";
import { Link } from "react-router-dom";
import { TfiClose } from "react-icons/tfi";
import useAuthContext from "../../hooks/useAuthContext";
import { useLoginGate } from "../../context/LoginGateContext";
import { useRegisterDialog } from "../../utils/dialogRegistry";

const RightSideDrawer = ({ showRightDrawer, setShowRightDrawer, cartData, removeFromCart, cartSubtotal }) => {
  const { user } = useAuthContext();
  const { requireLogin } = useLoginGate();
  // While the bag is open the timed sign-in prompt must not appear over it.
  useRegisterDialog("cart-drawer", showRightDrawer);

  if (!showRightDrawer) return null;

  // A guest's Checkout opens sign-in here and resumes to /checkout afterwards,
  // rather than bouncing them to the /login page.
  const onCheckout = (event) => {
    setShowRightDrawer(false);
    if (user) return;
    event.preventDefault();
    requireLogin({
      message: "Sign in to check out — we'll take you straight there afterwards.",
      intent: { type: "checkout" },
    });
  };

  return (
    <div className="fixed inset-0 z-[10000] overflow-hidden font-body-base">
      <div
        className="absolute inset-0 bg-[#353026]/40 backdrop-blur-sm transition-opacity duration-300"
        onClick={() => setShowRightDrawer(false)}
      ></div>
      <div className="absolute inset-y-0 right-0 max-w-full flex">
        <div className="w-screen md:max-w-md bg-surface shadow-heritage-lg flex flex-col h-full z-10 border-l border-outline-variant/30">
          
          <div className="p-4 md:p-6 border-b border-outline-variant/30 flex items-center justify-between bg-surface-container-low">
            <h3 className="text-xl md:text-2xl text-on-surface font-display-lg">
              Shopping Bag ({cartData?.length || 0})
            </h3>
            <button
              onClick={() => setShowRightDrawer(false)}
              className="p-3 text-on-surface-variant hover:text-primary transition-colors rounded-full hover:bg-surface-variant active:scale-95"
            >
              <TfiClose className="text-lg md:text-xl" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6">
            {cartData && cartData.length > 0 ? (
              cartData.map((item, idx) => (
                <div key={idx} className="flex gap-4 border-b border-outline-variant/20 pb-6 group">
                  <div className="w-20 h-20 md:w-24 md:h-24 shrink-0 border border-outline-variant/30 overflow-hidden bg-white">
                    <img
                      src={item.image || item.img || "/logo.png"}
                      alt={item.name}
                      className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500 mix-blend-multiply"
                    />
                  </div>
                  <div className="flex-1 flex flex-col justify-between py-1">
                    <div>
                      <h4 className="font-semibold text-base text-on-surface line-clamp-2 font-display">{item.name}</h4>
                      <p className="text-xs text-on-surface-variant mt-1 font-label-caps uppercase tracking-widest">Qty: {item.quantity || 1}</p>
                    </div>
                    <div className="flex justify-between items-center mt-2">
                      <p className="text-sm font-semibold text-primary">₹{(item.price || item.discountPrice)?.toLocaleString('en-IN')}</p>
                      <button
                        onClick={() => removeFromCart && removeFromCart(item._id || item.productId)}
                        className="text-on-surface-variant hover:text-error text-xs font-label-caps uppercase tracking-widest flex items-center gap-1 transition-ui md:opacity-0 group-hover:opacity-100 focus:opacity-100 p-2 -mr-2 active:scale-95"
                      >
                        <span className="material-symbols-outlined text-[16px]">delete</span>
                        Remove
                      </button>
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <div className="text-center py-32 flex flex-col items-center gap-4 text-on-surface-variant opacity-60">
                 <span className="material-symbols-outlined text-5xl">shopping_bag</span>
                <p className="text-xl font-display">Your shopping bag is empty.</p>
              </div>
            )}
          </div>

          <div className="p-4 md:p-6 border-t border-outline-variant/30 bg-surface-container-low space-y-6">
            <div className="flex justify-between items-center text-xl font-display-lg">
              <span className="text-on-surface-variant">Subtotal</span>
              <span className="font-semibold text-on-surface">₹{(cartSubtotal?.subtotal || 0).toLocaleString('en-IN')}</span>
            </div>
            
            <p className="text-xs text-on-surface-variant text-center -mt-4">
              Taxes and shipping calculated at checkout
            </p>

            <div className="space-y-3">
              <Link
                to="/checkout"
                onClick={onCheckout}
                className="block w-full bg-primary-container text-on-primary-container text-center py-4 md:py-5 font-button-text text-sm font-semibold uppercase tracking-widest hover:scale-[1.02] active:scale-95 transition-ui shadow-lg shadow-primary/10"
              >
                Checkout
              </Link>
              <Link
                to="/shop"
                onClick={() => setShowRightDrawer(false)}
                className="block w-full border border-primary text-primary text-center py-4 md:py-5 font-button-text text-sm font-semibold uppercase tracking-widest hover:bg-primary-container hover:text-on-primary-container active:scale-95 transition-ui"
              >
                Continue Shopping
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default RightSideDrawer;
