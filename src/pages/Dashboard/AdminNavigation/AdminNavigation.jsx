import React, { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import useAuthContext from "../../../hooks/useAuthContext";
import useUserInfo from "../../../hooks/useUserInfo";
import useAxiosSecure from "../../../hooks/useAxiosSecure";
import { useQuery } from "react-query";

const AdminNavigation = () => {
  const { user, logOut } = useAuthContext();
  const [userFromDB] = useUserInfo();
  const location = useLocation();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [axiosSecure] = useAxiosSecure();

  // Enquiries waiting for the owner. The WhatsApp alerts that would tell him
  // are not configured yet, so the count here is how a new enquiry gets seen:
  // refreshed every minute, on every admin page.
  const { data: pendingQuotes = 0 } = useQuery({
    queryKey: ["quote-summary"],
    enabled: userFromDB?.role === "ADMIN",
    refetchInterval: 60_000,
    queryFn: async () => (await axiosSecure.get("/quotes/summary")).data?.data?.pending || 0,
  });

  useEffect(() => {
    setMobileNavOpen(false);
  }, [location]);

  const handleLogout = () => {
    logOut().catch((e) => console.error(e?.code));
  };

  const navLinkClass = (path) => {
    const isActive = location.pathname.includes(path);
    return `flex items-center gap-4 px-4 py-3 rounded-lg transition-ui duration-300 ${
      isActive
        ? "bg-primary-container text-on-primary-container font-medium shadow-sm"
        : "text-on-surface-variant hover:bg-surface-variant"
    }`;
  };

  return (
    <>
      {/* Mobile top bar */}
      <div className="lg:hidden fixed top-0 left-0 right-0 h-16 bg-surface-container-low border-b border-outline-variant/30 flex items-center justify-between px-4 z-40">
        <span className="font-display-lg text-headline-sm text-primary">Admin Portal</span>
        <button
          onClick={() => setMobileNavOpen(true)}
          aria-label={pendingQuotes ? `Open menu (${pendingQuotes} pending quote requests)` : "Open menu"}
          className="text-on-surface p-2 -mr-2 relative"
        >
          <span className="material-symbols-outlined">menu</span>
          {pendingQuotes > 0 && (
            <span className="absolute top-1 right-1 w-2.5 h-2.5 rounded-full bg-error" aria-hidden="true" />
          )}
        </button>
      </div>

      {/* Backdrop for mobile drawer */}
      {mobileNavOpen && (
        <div
          className="lg:hidden fixed inset-0 bg-black/40 z-40"
          onClick={() => setMobileNavOpen(false)}
        ></div>
      )}

      <aside
        className={`w-72 bg-surface-container-low border-r border-outline-variant/30 flex flex-col z-50 h-screen shrink-0 fixed lg:static inset-y-0 left-0 transition-transform duration-300 ${
          mobileNavOpen ? "translate-x-0" : "-translate-x-full"
        } lg:translate-x-0`}
      >
        <button
          onClick={() => setMobileNavOpen(false)}
          className="lg:hidden absolute top-4 right-4 text-on-surface-variant hover:text-primary p-2"
          aria-label="Close menu"
        >
          <span className="material-symbols-outlined">close</span>
        </button>

        <div className="px-8 py-10">
          <div className="flex flex-col gap-4">
            <div className="w-24 h-24 mx-auto">
              <img
                src="https://lh3.googleusercontent.com/aida-public/AB6AXuBrNSXG2SMYhyPtorDFWVyvwy4-mU1tSsorVJXWvd8l7jvfYHHZq3Vvhv3p6lzscI0uU-XwURt0lT_1hiZalq78rmS5U1vEkVtNQspNPoRd8xZJ0zyJqymo2VQW-14NJ34CwtsKE48wsigwEtJjY63BEU2MOu5FNXgA4lvIXWMy1LgUufhhPuV5JG5nsmjrGTTi4rFucteF-YEd09g4wb_Q_h8aVilTj7OG8VmtfHTAcnDG8ybAmT-e4NxXtFdSq35NjUcSwuS1TOw"
                alt="Sri Ram Jewellery Logo"
                className="w-full h-full object-contain"
              />
            </div>
            <div className="text-center">
              <h1 className="font-display-lg text-headline-sm text-primary tracking-tight">
                Sri Ram Jewellery
              </h1>
              <p className="font-label-caps text-[10px] text-outline mt-1 uppercase tracking-widest">
                Admin Portal
              </p>
            </div>
          </div>
        </div>

        <nav className="flex-1 px-4 space-y-2 overflow-y-auto custom-scrollbar">
          <NavLink to="/dashboard/adminDashboard" className={navLinkClass("/adminDashboard")}>
            <span className="material-symbols-outlined text-[20px]">dashboard</span>
            <span className="font-button-text">Dashboard</span>
          </NavLink>
          <NavLink to="/dashboard/adminProducts" className={navLinkClass("/adminProducts")}>
            <span className="material-symbols-outlined text-[20px]">inventory_2</span>
            <span className="font-button-text">Products</span>
          </NavLink>
          <NavLink to="/dashboard/adminCategories" className={navLinkClass("/adminCategories")}>
            <span className="material-symbols-outlined text-[20px]">category</span>
            <span className="font-button-text">Categories</span>
          </NavLink>
          <NavLink to="/dashboard/adminOrders" className={navLinkClass("/adminOrders")}>
            <span className="material-symbols-outlined text-[20px]">shopping_bag</span>
            <span className="font-button-text">Orders</span>
          </NavLink>
          <NavLink to="/dashboard/adminQuoteRequests" className={navLinkClass("/adminQuoteRequests")}>
            <span className="material-symbols-outlined text-[20px]">request_quote</span>
            <span className="font-button-text">Quote Requests</span>
            {pendingQuotes > 0 && (
              <span
                className="ml-auto min-w-6 h-6 px-2 inline-flex items-center justify-center rounded-full bg-error text-on-error text-[11px] font-bold"
                aria-label={`${pendingQuotes} pending`}
                data-testid="pending-quotes"
              >
                {pendingQuotes}
              </span>
            )}
          </NavLink>

          <div className="pt-6 pb-2 px-4">
            <span className="font-label-caps text-outline text-[10px]">Management</span>
          </div>
          <NavLink to="/dashboard/adminLiveRates" className={navLinkClass("/adminLiveRates")}>
            <span className="material-symbols-outlined text-[20px]">currency_rupee</span>
            <span className="font-button-text">Live Rates</span>
          </NavLink>
          <NavLink to="/dashboard/adminUsers" className={navLinkClass("/adminUsers")}>
            <span className="material-symbols-outlined text-[20px]">group</span>
            <span className="font-button-text">Users</span>
          </NavLink>
          <NavLink to="/dashboard/adminMessages" className={navLinkClass("/adminMessages")}>
            <span className="material-symbols-outlined text-[20px]">mail</span>
            <span className="font-button-text">Messages</span>
          </NavLink>
          <NavLink to="/dashboard/adminSubscribers" className={navLinkClass("/adminSubscribers")}>
            <span className="material-symbols-outlined text-[20px]">mark_email_read</span>
            <span className="font-button-text">Subscribers</span>
          </NavLink>
        </nav>

        <div className="p-4 border-t border-outline-variant/30 mt-auto">
          <div className="flex items-center gap-3 p-3 rounded-xl bg-surface-container-highest/50">
            <div className="w-10 h-10 rounded-full bg-primary-container flex items-center justify-center text-white font-bold shrink-0">
              {userFromDB?.name?.[0]?.toUpperCase() || "A"}
            </div>
            <div className="flex-1 overflow-hidden">
              <p className="font-button-text truncate">{userFromDB?.name || "Admin User"}</p>
              <p className="text-[12px] text-outline truncate">
                {userFromDB?.email || "admin@sriram.com"}
              </p>
            </div>
            <button
              onClick={handleLogout}
              aria-label="Log out"
              title="Log out"
              className="flex items-center justify-center w-11 h-11 -mr-2 text-outline hover:text-primary shrink-0"
            >
              <span className="material-symbols-outlined">logout</span>
            </button>
          </div>
        </div>
      </aside>
    </>
  );
};

export default AdminNavigation;
