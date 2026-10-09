import React, { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useQuery } from "react-query";
import useUserInfo from "../../../hooks/useUserInfo";
import Select from "react-select";
import toast from "react-hot-toast";
import { Pagination } from "react-pagination-bar";
import LineChartComponent from "../../../components/LineChartComponent/LineChartComponent";
import useAdminStats from "../../../hooks/useAdminStats";
import useAuthContext from "../../../hooks/useAuthContext";
import useAxiosSecure from "../../../hooks/useAxiosSecure";
import 'react-pagination-bar/dist/index.css';

const AdminOrders = () => {
  const location = useLocation();
  const [userFromDB] = useUserInfo();
  const [axiosSecure] = useAxiosSecure();
  const { user, isAuthLoading } = useAuthContext();
  
  const { data: allOrders, isLoading: isOrdersLoading, refetch } = useQuery({
    enabled:
      !isAuthLoading &&
      user !== null &&
      user !== undefined &&
      (userFromDB?.admin === true || userFromDB?.role === "ADMIN"),
    queryKey: ["all-orders"],
    queryFn: async () => {
      const result = await axiosSecure.get("/orders/admin/all");
      return result.data;
    },
  });

  const { incomeStats } = useAdminStats();
  const refundsOwed = (allOrders || []).filter((o) => o.refundRequired);

  const handleStatusChange = (selectedOption, orderId) => {
    axiosSecure.patch(`/orders/${orderId}/status`, {
      status: selectedOption.value,
    })
    .then((res) => {
      if (res.data.success) {
        toast.success("Order status updated");
        refetch();
      }
    })
    // The server refuses changes the order lifecycle does not allow (e.g. an
    // expired order to shipped); show its reason and put the select back.
    .catch((e) => {
      toast.error(e.response?.data?.error || "Could not update the order status");
      refetch();
    });
  };

  // The 15-day delivery window is computed server-side from the approval time;
  // this only reports the outcome.
  const handleApproval = (orderId, approvalStatus) => {
    let rejectionReason;
    if (approvalStatus === "REJECTED") {
      rejectionReason = window.prompt("Why is this order being declined? The customer will see this.");
      if (rejectionReason === null) return;
      if (!rejectionReason.trim()) {
        toast.error("A reason is required when declining an order");
        return;
      }
    }

    axiosSecure
      .patch(`/orders/${orderId}/approval`, { approvalStatus, rejectionReason })
      .then((res) => {
        if (res.data.success) {
          toast.success(
            approvalStatus === "APPROVED"
              ? "Order approved — 15-day delivery window started"
              : "Order declined"
          );
          refetch();
        }
      })
      .catch((e) => toast.error(e.response?.data?.error || "Failed to update approval"));
  };

  const [currentPage, setCurrentPage] = useState(1);
  const pageProductLimit = 6;

  const selectStyles = {
    control: (base) => ({
      ...base,
      backgroundColor: 'transparent',
      borderColor: '#d4c3b9',
      boxShadow: 'none',
      '&:hover': {
        borderColor: '#704c31'
      },
      minHeight: '36px',
      fontSize: '13px'
    }),
    option: (base, { isFocused, isSelected }) => ({
      ...base,
      backgroundColor: isSelected ? '#8b6447' : isFocused ? '#f7edde' : 'transparent',
      color: isSelected ? 'white' : '#1f1b12',
      fontSize: '13px'
    })
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-background">
      {/* Top Bar */}
      <header className="h-20 flex items-center justify-between px-6 md:px-margin-desktop bg-background/80 backdrop-blur-md border-b border-outline-variant/30 z-40 shrink-0">
        <h2 className="font-display-lg text-headline-md text-primary">Orders</h2>
      </header>

      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto p-4 md:p-margin-desktop custom-scrollbar">
        {/* Refunds owed: first thing on the page, never only inside a row on
            some later page of the table. Set when a PAID order is cancelled or
            declined, or paid after its reservation expired. Refunds are made
            by hand in the Razorpay dashboard. */}
        {refundsOwed.length > 0 && (
          <div role="status" className="mb-8 p-4 md:p-5 rounded-xl border border-error/30 bg-error-container text-on-error-container">
            <p className="font-semibold flex items-center gap-2">
              <span className="material-symbols-outlined text-[20px]" aria-hidden="true">currency_rupee</span>
              {refundsOwed.length === 1 ? "1 paid order needs a refund" : `${refundsOwed.length} paid orders need a refund`}
            </p>
            <ul className="mt-2 text-sm space-y-1">
              {refundsOwed.map((o) => (
                <li key={o._id}>
                  <span className="font-semibold">{o.orderId}</span> — ₹{Number(o.totalAmount || 0).toLocaleString("en-IN")}
                  {o.name ? ` · ${o.name}` : ""}
                  {o.razorpayPaymentId ? ` · payment ${o.razorpayPaymentId}` : ""}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs">Refund each one by hand from the Razorpay dashboard. Nothing is refunded automatically.</p>
          </div>
        )}
        {/* Chart Section */}
        <div className="bg-surface-dim border border-secondary/20 rounded-xl p-4 md:p-6 mb-8 h-auto">
          <h3 className="font-headline-sm text-primary mb-4 font-display">Revenue Trend</h3>
          <div className="h-[250px]">
            <LineChartComponent data={incomeStats} />
          </div>
        </div>

        {/* Table Section */}
        <div className="bg-surface-dim border border-secondary/20 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse min-w-[800px]">
              <thead>
                <tr className="border-b border-outline-variant/50 bg-surface-container-high/50">
                  <th className="px-6 py-4 font-label-caps text-outline text-[11px]">Order #</th>
                  <th className="px-6 py-4 font-label-caps text-outline text-[11px]">Date</th>
                  <th className="px-6 py-4 font-label-caps text-outline text-[11px]">Customer</th>
                  <th className="px-6 py-4 font-label-caps text-outline text-[11px]">Payment</th>
                  <th className="px-6 py-4 font-label-caps text-outline text-[11px]">Total</th>
                  <th className="px-6 py-4 font-label-caps text-outline text-[11px]">Approval</th>
                  <th className="px-6 py-4 font-label-caps text-outline text-[11px]">Expected Delivery</th>
                  <th className="px-6 py-4 font-label-caps text-outline text-[11px]">Status</th>
                  <th className="px-6 py-4 font-label-caps text-outline text-[11px] text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant/20">
                {isOrdersLoading ? (
                  <tr>
                    <td colSpan="9" className="px-6 py-10 text-center text-outline">Loading orders...</td>
                  </tr>
                ) : allOrders?.slice((currentPage - 1) * pageProductLimit, currentPage * pageProductLimit).map((order) => (
                  <tr key={order._id} className="hover:bg-white/40 transition-colors group">
                    <td className="px-6 py-4">
                      <p className="font-button-text text-primary">#{order.orderId}</p>
                    </td>
                    <td className="px-6 py-4">
                      <p className="text-[13px] text-on-surface-variant">
                        {order.createdAt && new Date(order.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}
                      </p>
                    </td>
                    <td className="px-6 py-4">
                      <p className="font-button-text text-on-surface">{order.name || order.email || order.phone || "—"}</p>
                      <p className="text-[12px] text-outline mt-1">{order.items?.length || 0} items</p>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex flex-col gap-1">
                        <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-medium uppercase tracking-wider w-fit border ${
                          order.paymentStatus?.toLowerCase() === "paid" 
                            ? "bg-success/10 text-success border-success/20" 
                            : "bg-error/10 text-error border-error/20"
                        }`}>
                          {order.paymentStatus}
                        </span>
                        <span className="text-[11px] text-outline">
                          {order.paymentMethod === "cod" ? "COD" : (order.razorpayPaymentId || order.paymentMethod)}
                        </span>
                        {order.refundRequired && (
                          <span className="inline-block px-2 py-0.5 rounded text-[11px] font-semibold uppercase tracking-wider w-fit border bg-error-container text-on-error-container border-error/30">
                            Refund needed
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <p className="font-button-text">₹ {(order.totalAmount || 0).toLocaleString("en-IN")}</p>
                    </td>
                    <td className="px-6 py-4">
                      {(order.approvalStatus || "PENDING") === "PENDING" ? (
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => handleApproval(order._id, "APPROVED")}
                            className="inline-flex items-center justify-center min-h-11 px-3 py-2 rounded border border-success/40 text-[12px] font-medium text-success hover:bg-success hover:text-white transition-ui"
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            onClick={() => handleApproval(order._id, "REJECTED")}
                            className="inline-flex items-center justify-center min-h-11 px-3 py-2 rounded border border-error/40 text-[12px] font-medium text-error hover:bg-error hover:text-white transition-ui"
                          >
                            Reject
                          </button>
                        </div>
                      ) : order.approvalStatus === "APPROVED" ? (
                        <span className="inline-block px-2 py-0.5 rounded text-[11px] font-medium uppercase tracking-wider border bg-success/10 text-success border-success/20">
                          Approved
                        </span>
                      ) : (
                        <div className="flex flex-col gap-1">
                          <span className="inline-block px-2 py-0.5 rounded text-[11px] font-medium uppercase tracking-wider border bg-error/10 text-error border-error/20 w-fit">
                            Rejected
                          </span>
                          {order.rejectionReason && (
                            <span className="text-[11px] text-outline max-w-[180px]">{order.rejectionReason}</span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      <p className="text-[13px] text-on-surface-variant">
                        {order.expectedDeliveryDate
                          ? new Date(order.expectedDeliveryDate).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
                          : "—"}
                      </p>
                    </td>
                    <td className="px-6 py-4">
                      <Select
                        options={[
                          { value: "processing", label: "PROCESSING" },
                          { value: "shipped", label: "SHIPPED" },
                          { value: "delivered", label: "DELIVERED" },
                          { value: "cancelled", label: "CANCELLED" },
                        ]}
                        value={{ value: order.orderStatus, label: order.orderStatus?.toUpperCase() }}
                        onChange={(e) => handleStatusChange(e, order._id)}
                        styles={selectStyles}
                        className="w-36"
                        isSearchable={false}
                      />
                    </td>
                    <td className="px-6 py-4 text-right">
                      <Link className="inline-flex" to="/order-success" state={{ from: location, orderId: order._id }}>
                        <button className="inline-flex items-center justify-center min-h-11 px-4 py-2 rounded border border-outline-variant/50 text-[12px] font-medium text-outline hover:text-primary hover:border-primary transition-ui">
                          View
                        </button>
                      </Link>
                    </td>
                  </tr>
                ))}
                {allOrders?.length === 0 && (
                  <tr>
                    <td colSpan="9" className="px-6 py-10 text-center text-outline">No orders found.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          
          {/* Pagination */}
          {allOrders?.length > 0 && (
            <div className="p-4 border-t border-outline-variant/20 flex flex-col sm:flex-row items-center justify-between gap-4 bg-surface-container-high/20">
              <p className="text-[12px] text-outline">
                Showing {(currentPage - 1) * pageProductLimit + 1} to {Math.min(currentPage * pageProductLimit, allOrders.length)} of {allOrders.length} orders
              </p>
              <div className="scale-90 sm:scale-100 origin-right">
                <Pagination
                  currentPage={currentPage}
                  totalItems={allOrders.length}
                  onPageChange={(pageNumber) => setCurrentPage(pageNumber)}
                  itemsPerPage={pageProductLimit}
                  pageNeighbours={1}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default AdminOrders;
