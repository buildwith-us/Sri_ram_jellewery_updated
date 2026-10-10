import React, { useState } from "react";
import { useQuery, useQueryClient } from "react-query";
import Select from "react-select";
import toast from "react-hot-toast";
import { Pagination } from "react-pagination-bar";
import useAxiosSecure from "../../../hooks/useAxiosSecure";
import 'react-pagination-bar/dist/index.css';

const formatPhone = (phone) => {
  const national = String(phone || "").replace(/^\+91/, "");
  return /^\d{10}$/.test(national) ? `+91 ${national.slice(0, 5)} ${national.slice(5)}` : phone;
};

/** How the enquiry came in. "whatsapp": the customer also opened a chat carrying the reference. */
const ChannelBadge = ({ channel }) =>
  channel === "whatsapp" ? (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#1f7a4d]/10 text-[#1f7a4d] font-label-caps text-[10px] whitespace-nowrap">
      WhatsApp
    </span>
  ) : (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-primary/10 text-primary font-label-caps text-[10px]">
      Form
    </span>
  );

const AdminQuoteRequests = () => {
  const [axiosSecure] = useAxiosSecure();
  const queryClient = useQueryClient();
  
  const { data: quoteRequests, isLoading: isQuotesLoading, refetch } = useQuery({
    queryKey: ["admin-quotes"],
    queryFn: async () => {
      const result = await axiosSecure.get("/quotes");
      return result.data?.data || [];
    },
  });

  const handleStatusChange = (selectedOption, quoteId) => {
    axiosSecure.patch(`/quotes/${quoteId}/status`, {
      status: selectedOption.value,
    })
    .then((res) => {
      if (res.data.success) {
        toast.success("Quote status updated");
        refetch();
        queryClient.invalidateQueries(["quote-summary"]); // the count in the navigation
      }
    })
    .catch((e) => {
      console.error(e);
      toast.error("Failed to update status");
    });
  };

  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 8;
  const displayedQuotes = quoteRequests?.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);

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
        <h2 className="font-display-lg text-headline-md text-primary">Quote Requests</h2>
        {quoteRequests?.length > 0 && (
          <p className="text-sm text-on-surface-variant">
            {quoteRequests.filter((q) => q.status === "Pending").length} pending
          </p>
        )}
      </header>

      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto p-4 md:p-margin-desktop custom-scrollbar">
        {/* Table Section */}
        <div className="bg-surface-dim border border-secondary/20 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse min-w-[800px]">
              <thead>
                <tr className="border-b border-outline-variant/50 bg-surface-container-high/50">
                  <th className="px-6 py-4 font-label-caps text-outline text-[11px]">Ref</th>
                  <th className="px-6 py-4 font-label-caps text-outline text-[11px]">Product</th>
                  <th className="px-6 py-4 font-label-caps text-outline text-[11px]">Customer</th>
                  <th className="px-6 py-4 font-label-caps text-outline text-[11px]">Contact</th>
                  <th className="px-6 py-4 font-label-caps text-outline text-[11px]">Via</th>
                  <th className="px-6 py-4 font-label-caps text-outline text-[11px]">Date</th>
                  <th className="px-6 py-4 font-label-caps text-outline text-[11px]">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant/20">
                {isQuotesLoading ? (
                  <tr>
                    <td colSpan="7" className="px-6 py-10 text-center text-outline">Loading requests...</td>
                  </tr>
                ) : displayedQuotes?.map((quote) => (
                  <tr key={quote._id} className="hover:bg-white/40 transition-colors group" data-testid="quote-row">
                    <td className="px-6 py-4">
                      {/* What the customer's WhatsApp message quotes. Older
                          enquiries were made before references existed. */}
                      <p className="font-button-text text-on-surface whitespace-nowrap">{quote.quoteId || "—"}</p>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        {quote.productImage && (
                          <img src={quote.productImage} alt="Product" className="w-12 h-12 rounded object-cover border border-outline-variant/30" />
                        )}
                        <div>
                          <p className="font-button-text text-primary">{quote.productName}</p>
                          <p className="text-[12px] text-outline mt-1">ID: {quote.productId}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <p className="font-button-text text-on-surface">{quote.customerName}</p>
                    </td>
                    <td className="px-6 py-4">
                      <a
                        href={`tel:${quote.customerMobile}`}
                        className="inline-flex items-center gap-1 min-h-11 font-button-text text-primary hover:underline whitespace-nowrap"
                        aria-label={`Call ${quote.customerName} on ${formatPhone(quote.customerMobile)}`}
                      >
                        <span className="material-symbols-outlined text-[18px]" aria-hidden="true">call</span>
                        {formatPhone(quote.customerMobile)}
                      </a>
                    </td>
                    <td className="px-6 py-4">
                      <ChannelBadge channel={quote.channel} />
                    </td>
                    <td className="px-6 py-4">
                      <p className="text-[13px] text-on-surface-variant">
                        {new Date(quote.createdAt).toLocaleDateString()}
                      </p>
                    </td>
                    <td className="px-6 py-4">
                      <Select
                        options={[
                          { value: "Pending", label: "Pending" },
                          { value: "Contacted", label: "Contacted" },
                          { value: "Closed", label: "Closed" },
                        ]}
                        value={{ value: quote.status, label: quote.status }}
                        onChange={(e) => handleStatusChange(e, quote._id)}
                        styles={selectStyles}
                        className="w-36"
                        isSearchable={false}
                      />
                    </td>
                  </tr>
                ))}
                {quoteRequests?.length === 0 && (
                  <tr>
                    <td colSpan="7" className="px-6 py-10 text-center text-outline">No quote requests found.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          
          {/* Pagination */}
          {quoteRequests?.length > 0 && (
            <div className="p-4 border-t border-outline-variant/20 flex flex-col sm:flex-row items-center justify-between gap-4 bg-surface-container-high/20">
              <p className="text-[12px] text-outline">
                Showing {(currentPage - 1) * itemsPerPage + 1} to {Math.min(currentPage * itemsPerPage, quoteRequests.length)} of {quoteRequests.length} requests
              </p>
              <div className="scale-90 sm:scale-100 origin-right">
                <Pagination
                  currentPage={currentPage}
                  totalItems={quoteRequests.length}
                  onPageChange={(pageNumber) => setCurrentPage(pageNumber)}
                  itemsPerPage={itemsPerPage}
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

export default AdminQuoteRequests;
