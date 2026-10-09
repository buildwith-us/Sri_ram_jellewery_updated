import React, { useEffect, useState, useContext } from "react";
import useUserInfo from "../../hooks/useUserInfo";
import useAxiosSecure from "../../hooks/useAxiosSecure";
import useAuthContext from "../../hooks/useAuthContext";
import { PaymentContext } from "../Checkout/Checkout";

const RAZORPAY_SRC = "https://checkout.razorpay.com/v1/checkout.js";

// Line totals are floating point, so compare against the displayed total with
// a paisa of tolerance rather than strict equality.
const TOTAL_TOLERANCE = 0.01;

/**
 * Razorpay renders the merchant logo inside its own https iframe, so a relative
 * path like "/logo.png" resolves against the *checkout* origin, not ours — it
 * is blocked as mixed content in local http and silently fails in production.
 * It has to be an absolute https URL.
 *
 * Returns undefined when unconfigured: Razorpay then shows its default header,
 * which is better than a broken image request.
 */
const getMerchantLogoUrl = () => {
  const base = import.meta.env.VITE_PUBLIC_SITE_URL;
  if (!base) return undefined;

  const normalised = base.replace(/\/+$/, "");
  if (!normalised.startsWith("https://")) {
    console.warn(
      `VITE_PUBLIC_SITE_URL is "${base}" — Razorpay only loads the merchant logo over https, so it will be omitted.`
    );
    return undefined;
  }
  return `${normalised}/logo.png`;
};

const Payment = () => {
  const [userFromDB] = useUserInfo();
  const [axiosSecure] = useAxiosSecure();
  const { user } = useAuthContext();
  const customerName = user?.name || userFromDB?.name || user?.displayName || "Customer";
  // Items come from the checkout context, never from the cart directly — the
  // cart is not what is being bought when the customer used "Buy Now".
  const { orderTotal, checkoutItems, isBuyNow, setPaymentInfo } = useContext(PaymentContext);

  const [scriptLoaded, setScriptLoaded] = useState(false);
  const [loadingPayment, setLoadingPayment] = useState(false);
  const [paymentError, setPaymentError] = useState(null);
  const [paymentSuccess, setPaymentSuccess] = useState(false);

  // Dynamically load Razorpay Checkout Script
  useEffect(() => {
    const loadRazorpayScript = () => {
      return new Promise((resolve) => {
        if (window.Razorpay) {
          resolve(true);
          return;
        }
        // window.Razorpay only exists once the script has finished loading, so
        // that check alone lets a second tag be appended while the first is
        // still in flight — which StrictMode's double-invoked effect does every
        // time in development. Reuse any tag that is already loading instead;
        // otherwise the SDK boots twice and duplicates all of its telemetry.
        const existing = document.querySelector(`script[src="${RAZORPAY_SRC}"]`);
        if (existing) {
          existing.addEventListener("load", () => resolve(true), { once: true });
          existing.addEventListener("error", () => resolve(false), { once: true });
          return;
        }
        const script = document.createElement("script");
        script.src = RAZORPAY_SRC;
        script.async = true;
        script.onload = () => resolve(true);
        script.onerror = () => resolve(false);
        document.body.appendChild(script);
      });
    };

    loadRazorpayScript().then((loaded) => {
      setScriptLoaded(loaded);
    });
  }, []);

  const handlePayment = async () => {
    if (!scriptLoaded) {
      setPaymentError("Razorpay payment gateway is currently unavailable. Please refresh or try again.");
      return;
    }

    setLoadingPayment(true);
    setPaymentError(null);

    if (!checkoutItems || !checkoutItems.length) {
      setPaymentError("There is nothing to pay for. Please add an item and try again.");
      setLoadingPayment(false);
      return;
    }

    // Quote-only pieces are priced on request, so there is no amount to charge.
    // They must never reach Razorpay.
    if (checkoutItems.some((item) => item.price == null || item.isQuoteOnly)) {
      setPaymentError(
        "This order contains a price-on-request item, which cannot be paid for online. Please request a quote instead."
      );
      setLoadingPayment(false);
      return;
    }

    // The amount the customer is about to authorise must equal the amount shown
    // on the button. If these disagree, the items and the total came from
    // different places and the order would be wrong.
    const itemsTotal = checkoutItems.reduce(
      (sum, item) => sum + (item.price || 0) * (item.quantity || 1),
      0
    );
    if (Math.abs(itemsTotal - (orderTotal || 0)) > TOTAL_TOLERANCE) {
      setPaymentError("Your order total does not match the items in it. Please refresh and try again.");
      setLoadingPayment(false);
      return;
    }

    if (!userFromDB?.shippingAddress) {
      setPaymentError("Please provide a shipping address before proceeding.");
      setLoadingPayment(false);
      return;
    }

    try {
      // 1. Create order on the backend server securely with cart items
      let orderId = null;
      let amount = 0;
      let razorpayKey = null;
      let dbOrderId = null;
      try {
        const response = await axiosSecure.post("/payment/create-order", {
          items: checkoutItems,
          shippingAddress: userFromDB?.shippingAddress,
          name: customerName,
          // Tells the server to leave the bag alone when this payment is
          // confirmed (B21): a Buy Now never came from it.
          buyNow: Boolean(isBuyNow),
        });
        orderId = response.data?.razorpayOrderId;
        amount = response.data?.amount;
        razorpayKey = response.data?.key;
        dbOrderId = response.data?.orderId;
      } catch (err) {
        console.error("Backend order creation failed", err);
        setPaymentError(err.response?.data?.error || "Failed to initialize payment. Please try again.");
        setLoadingPayment(false);
        return;
      }

      // 2. Open Razorpay Checkout modal
      const options = {
        key: razorpayKey || import.meta.env.VITE_RAZORPAY_KEY_ID || "rzp_test_YOUR_KEY_HERE",
        amount: Math.round(amount * 100), // Razorpay expects amount in paise (1 INR = 100 paise)
        currency: "INR",
        name: "Sri Ram Jewellery",
        description: "Secure purchase of premium jewellery",
        image: getMerchantLogoUrl(),
        order_id: orderId,
        handler: async function (response) {
          try {
            setLoadingPayment(true);
            
            // 3. Verify signature securely on backend
            const verifyRes = await axiosSecure.post("/payment/verify", {
              razorpay_order_id: response.razorpay_order_id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature: response.razorpay_signature,
            });

            if (verifyRes.data.success) {
              setPaymentInfo({
                status: "success",
                id: response.razorpay_payment_id,
                orderId: dbOrderId,
                razorpay_order_id: response.razorpay_order_id,
                razorpay_signature: response.razorpay_signature,
              });
              setPaymentSuccess(true);
            } else {
              setPaymentError("Payment verification failed. If money was deducted, it will be refunded.");
            }
          } catch (verifyErr) {
            console.error("Verification error:", verifyErr);
            setPaymentError("Payment verification failed or timed out.");
          } finally {
            setLoadingPayment(false);
          }
        },
        prefill: {
          name: customerName,
          email: user?.email || "",
          contact: userFromDB?.shippingAddress?.number || userFromDB?.shippingAddress?.mobileNumber || "",
        },
        theme: {
          color: "#704c31", // Matching the application's brand color
        },
        modal: {
          ondismiss: function () {
            setLoadingPayment(false);
          },
        },
      };

      const rzp = new window.Razorpay(options);
      rzp.on('payment.failed', function (response){
        console.error("Payment failed:", response.error);
        setPaymentError(response.error.description || "Payment failed. Please try again.");
        setLoadingPayment(false);
      });
      rzp.open();
    } catch (error) {
      console.error("Razorpay initiation failed:", error);
      setPaymentError("Unable to open Razorpay payment popup. Please check your network and try again.");
      setLoadingPayment(false);
    }
  };

  return (
    <div className="ml-5 mt-5">
      <div className="border md:w-[60%] p-8 pb-6 rounded-xl shadow bg-white border-outline-variant/40">
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="flex flex-col items-center gap-2 text-primary mb-2">
            <span className="material-symbols-outlined text-[48px]">verified_user</span>
          </div>
          <div>
            <h3 className="font-display-lg text-headline-sm text-on-surface mb-2">Secure Payment with Razorpay</h3>
            <p className="text-body-base text-on-surface-variant font-body-base">
              Pay securely via UPI, Cards, NetBanking, or Wallet
            </p>
          </div>
          
          <div className="w-full mt-2">
            <div className="flex justify-between items-center bg-surface-container-low p-3 rounded-lg border border-outline-variant/40 mb-4">
              <span className="text-on-surface-variant font-medium text-sm">Order Subtotal:</span>
              <span className="text-lg font-bold text-on-surface">₹{orderTotal}</span>
            </div>

            {paymentSuccess ? (
              <div className="p-3 bg-success/10 text-success rounded-lg border border-success/30 font-semibold text-sm flex items-center justify-center gap-2">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
                </svg>
                Payment Authorized!
              </div>
            ) : (
              <button
                onClick={handlePayment}
                disabled={loadingPayment || !scriptLoaded}
                className="w-full bg-primary text-white py-4 font-button-text text-button-text tracking-widest hover:brightness-110 active:scale-[0.98] transition-ui flex items-center justify-center gap-3 rounded-sm"
              >
                {loadingPayment ? (
                  <span className="loading loading-spinner text-white"></span>
                ) : (
                  <span className="font-button-text text-button-text">PAY ₹{orderTotal} WITH RAZORPAY</span>
                )}
              </button>
            )}
          </div>

          {paymentError && (
            <div className="mt-3 text-xs text-error font-semibold">
              {paymentError}
            </div>
          )}
          
          <div className="flex items-center gap-1.5 mt-2 text-[10px] text-on-surface-variant/60">
            <svg className="w-3.5 h-3.5 text-success" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
            100% Safe and Encrypted Payments
          </div>
        </div>
      </div>
    </div>
  );
};

export default Payment;

