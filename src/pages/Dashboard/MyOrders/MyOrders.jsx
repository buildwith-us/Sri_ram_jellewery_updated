import React from "react";
import useOrders from "../../../hooks/useOrders";
import { Link, useNavigate } from "react-router-dom";
import Swal from "sweetalert2";
import useAxiosSecure from "../../../hooks/useAxiosSecure";
import { ListSkeleton } from "../../../components/Skeleton/Skeleton";

const MyOrders = () => {
  const { orders, isOrdersLoading, refetch } = useOrders();
  const [axiosSecure] = useAxiosSecure();
  const navigate = useNavigate();

  const handleDeleteOrder = (order, e) => {
    e.stopPropagation();
    const today = new Date();
    const orderDate = new Date(order.createdAt);
    const diffInDays = Math.floor((today - orderDate) / (1000 * 60 * 60 * 24));

    if (diffInDays > 7) {
      Swal.fire({
        title: "Too Late",
        text: "No orders can be cancelled after 7 days of ordering.",
        icon: "error",
        confirmButtonColor: "#8B6447",
        confirmButtonText: "Ok, take me back",
      });
    } else {
      // A paid online order is refunded by hand by the shop — say so before
      // the customer commits, and never promise an instant refund.
      const paidOnline = Boolean(order.paidAt) && String(order.paymentMethod || "").toLowerCase() !== "cod";
      const amount = `₹${Number(order.totalAmount || 0).toLocaleString("en-IN")}`;
      const refundNote = paidOnline
        ? `<br><br>You paid ${amount} online. The shop refunds it to your original payment method <b>by hand</b>; once issued, a refund usually reaches you within <b>5–7 working days</b>. It is not instant.`
        : "";
      Swal.fire({
        title: "Cancel Order?",
        html: `Your order will be cancelled.${refundNote}<br><br>See our <a href="/legal/cancellation-policy" target="_blank" class="underline text-primary">cancellation policy</a>.`,
        icon: "warning",
        showCancelButton: true,
        confirmButtonColor: "#8B6447",
        cancelButtonColor: "#c8a684",
        confirmButtonText: "Yes, cancel it!",
      }).then((result) => {
        if (result.isConfirmed) {
          axiosSecure
            .patch(`/orders/${order._id}/cancel`)
            .then((res) => {
              if (res.data.success) {
                Swal.fire({
                  title: "Cancelled",
                  text: paidOnline
                    ? `Your order has been cancelled. Your refund of ${amount} is pending: the shop will issue it by hand, and it usually reaches you within 5–7 working days after that.`
                    : "Your order has been cancelled successfully",
                  icon: "success",
                  confirmButtonColor: "#8B6447",
                });
                refetch();
              }
            })
            .catch((error) => {
              Swal.fire({
                title: "Couldn't Cancel",
                text: error.response?.data?.error || "Something went wrong. Please try again.",
                icon: "error",
                confirmButtonColor: "#8B6447",
              });
            });
        }
      });
    }
  };

  const navigateToOrder = (orderId) => {
    navigate("/order-success", { state: { orderId } });
  };

  return (
    <div className="w-full">
      {/* Header Section */}
      <div className="mb-12">
        <span className="font-label-caps text-label-caps text-secondary block mb-2 tracking-[0.3em] uppercase">
          YOUR ACCOUNT
        </span>
        <h1 className="font-display-lg text-display-lg text-primary">My Orders</h1>
      </div>

      {/* Loading is checked before emptiness. Without this the page rendered
          "your order box is empty" during every fetch — telling a customer who
          does have orders that they have none. */}
      {isOrdersLoading ? (
        <ListSkeleton rows={3} />
      ) : !orders?.length ? (
        <div className="flex flex-col items-center justify-center py-16 text-center" id="empty-state">
          <div className="w-24 h-24 rounded-full bg-surface-container-highest flex items-center justify-center mb-8">
            <span className="material-symbols-outlined text-4xl text-outline">shopping_bag</span>
          </div>
          <span className="font-label-caps text-label-caps text-secondary block mb-2 tracking-[0.3em] uppercase">
            NO HISTORY
          </span>
          <h2 className="font-headline-md text-headline-md text-on-surface mb-6">Your order box is empty</h2>
          <p className="font-body-base text-body-base text-on-surface-variant max-w-sm mb-10 leading-relaxed">
            It seems you haven't started your artisanal collection yet. Explore our curated heritage pieces and find your next heirloom.
          </p>
          <Link 
            to="/shop" 
            className="font-button-text text-button-text border border-primary px-10 py-4 hover:bg-primary hover:text-white transition-ui uppercase tracking-[0.2em] cursor-pointer"
          >
            Start Shopping
          </Link>
        </div>
      ) : (
        <div className="flex flex-col gap-6" id="orders-list">
          {orders.map((order) => {
            const isProcessing = order.orderStatus?.toLowerCase() === "processing";
            const isDelivered = order.orderStatus?.toLowerCase() === "delivered";

            const approval = order.approvalStatus || "PENDING";
            const isApproved = approval === "APPROVED";
            const isRejected = approval === "REJECTED";

            const formatDate = (value) =>
              value
                ? new Date(value).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })
                : null;

            const deliveredOn = formatDate(order.deliveredAt);
            const expectedBy = formatDate(order.expectedDeliveryDate);

            // Counted from the server's date, not recomputed here — the client
            // displays the delivery window, it never decides it.
            const daysRemaining = order.expectedDeliveryDate
              ? Math.ceil(
                  (new Date(order.expectedDeliveryDate) - new Date()) / (1000 * 60 * 60 * 24)
                )
              : null;

            // A delivered order with no deliveredAt is legacy data, deliberately
            // not backfilled — show a dash rather than inventing today's date.
            let timelineText;
            if (order.refundRequired) {
              // Honest about what happens next: nothing has been refunded yet,
              // and the shop does it by hand. Never shown as "Refunded".
              timelineText =
                `Cancelled — refund pending. The shop will refund ₹${Number(order.totalAmount || 0).toLocaleString("en-IN")} ` +
                "to your original payment method by hand. Once it's issued, it usually reaches you within 5–7 working days.";
            } else if (isDelivered) {
              timelineText = `Delivered on ${deliveredOn || "—"}`;
            } else if (isRejected) {
              timelineText = order.rejectionReason
                ? `Order declined: ${order.rejectionReason}`
                : "Order declined";
            } else if (isApproved && expectedBy) {
              timelineText =
                daysRemaining > 0
                  ? `Expected delivery by ${expectedBy} (${daysRemaining} day${daysRemaining === 1 ? "" : "s"} remaining)`
                  : `Expected delivery by ${expectedBy}`;
            } else {
              timelineText =
                "Awaiting confirmation — your 15-day delivery window starts once we approve this order.";
            }

            return (
              <div 
                key={order._id} 
                className="p-6 md:p-8 bg-surface-container-low/50 border border-sand/30 group cursor-pointer relative overflow-hidden transition-ui duration-500 hover:bg-white hover:-translate-y-1 hover:shadow-[0_20px_40px_-10px_rgba(139,100,71,0.08)]"
                onClick={() => navigateToOrder(order._id)}
              >
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6 relative z-10">
                  <div className="flex gap-4">
                    <div className="flex -space-x-4">
                      {(order.items || order.orderDetails || []).slice(0, 3).map((item, i) => (
                        <div key={item._id || i} className="w-16 h-16 md:w-20 md:h-20 bg-surface-variant border border-sand/30 flex items-center justify-center overflow-hidden rounded-sm">
                          <img 
                            className="w-full h-full object-cover transform group-hover:scale-110 transition-transform duration-700" 
                            src={item.img || item.image || "/logo.png"} 
                            alt={item.name || "Product"} 
                          />
                        </div>
                      ))}
                      {(order.items || order.orderDetails || []).length > 3 && (
                        <div className="w-16 h-16 md:w-20 md:h-20 border border-sand/30 flex items-center justify-center overflow-hidden rounded-sm bg-surface-dim z-10">
                          <span className="font-body-base text-sm font-semibold text-primary">+{(order.items || order.orderDetails || []).length - 3}</span>
                        </div>
                      )}
                    </div>
                    
                    <div className="flex flex-col justify-center pl-2">
                      <span className="font-label-caps text-[10px] text-on-surface-variant mb-1 uppercase tracking-widest">
                        Order #{order.orderId || order._id.slice(-6).toUpperCase()}
                      </span>
                      <span className="font-headline-sm text-headline-sm text-on-surface">
                        {(order.items || order.orderDetails || [])[0]?.name || "Heritage Collection"} {(order.items || order.orderDetails || []).length > 1 ? "& More" : ""}
                      </span>
                      <p className="font-body-base text-sm text-on-surface-variant mt-1">
                        Placed on {new Date(order.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-col md:items-end gap-3 w-full md:w-auto">
                    <div className="flex flex-wrap gap-2 md:justify-end">
                      {/* Approval is a separate axis from fulfilment status:
                          a PENDING order is still "processing", it just is not
                          confirmed yet. */}
                      {!isRejected && (
                        <span className={`px-3 py-1 border text-[10px] font-label-caps uppercase tracking-widest rounded-full ${
                          isApproved
                            ? 'border-success/40 text-success bg-success/5'
                            : 'border-secondary/40 text-secondary bg-white/50'
                        }`}>
                          {isApproved ? 'CONFIRMED' : 'AWAITING CONFIRMATION'}
                        </span>
                      )}
                      {isRejected && (
                        <span className="px-3 py-1 border border-error/40 text-error bg-error/5 text-[10px] font-label-caps uppercase tracking-widest rounded-full">
                          DECLINED
                        </span>
                      )}
                      <span className={`px-3 py-1 border text-[10px] font-label-caps uppercase tracking-widest rounded-full ${
                        isProcessing ? 'border-secondary/40 text-secondary bg-white/50' :
                        isDelivered ? 'border-outline-variant/40 text-on-surface-variant bg-surface-variant/30' :
                        'border-primary/40 text-primary bg-primary/5'
                      }`}>
                        {order.orderStatus?.toUpperCase() || 'UNKNOWN'}
                      </span>
                    </div>
                    <span className="font-display-lg text-2xl md:text-3xl text-primary">
                      ₹{order.totalAmount || order.total || 0}
                    </span>
                  </div>
                </div>

                {/* Actions — always visible on touch, hover-reveal on desktop */}
                <div className="mt-6 pt-6 border-t border-outline-variant/20 flex flex-wrap gap-4 items-center justify-between opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity duration-500">
                  <p className="font-body-base text-xs text-on-surface-variant italic max-w-md">
                    {timelineText}
                  </p>
                  <div className="flex gap-4 w-full sm:w-auto">
                    {isProcessing && (
                      <button 
                        onClick={(e) => handleDeleteOrder(order, e)}
                        className="font-button-text text-button-text text-error/80 border border-error/30 px-4 py-2 hover:bg-error hover:text-white transition-ui uppercase tracking-widest flex items-center gap-2 cursor-pointer"
                      >
                        <span className="material-symbols-outlined text-[16px]">cancel</span> Cancel Order
                      </button>
                    )}
                    <button 
                      onClick={(e) => { e.stopPropagation(); navigateToOrder(order._id); }}
                      className="flex-1 sm:flex-none font-button-text text-button-text bg-primary text-white px-6 py-2 hover:bg-primary/90 transition-ui uppercase tracking-widest cursor-pointer"
                    >
                      {isDelivered ? 'Buy Again' : 'Track Order'}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default MyOrders;
