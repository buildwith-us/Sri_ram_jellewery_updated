import React, { useEffect } from "react";
import { Outlet, useLocation } from "react-router-dom";
import Header from "../pages/Header/Header";
import Footer from "../pages/Footer/Footer";

const MainLayoutInner = () => {
  const location = useLocation();

  // Scroll to top on route change
  useEffect(() => {
    if (
      (location?.pathname?.includes("description") &&
        location?.state?.from !== "/") ||
      (location?.pathname?.includes("reviews") && location?.state?.from !== "/")
    ) {
      // ignore scroll to top in dynamic product page details navigation
    } else {
      document.documentElement.scroll({
        top: 0,
        left: 0,
        behavior: "smooth",
      });
    }
  }, [location]);

  return (
    <div className="w-full">
      <Header />
      <Outlet />
      <Footer />
    </div>
  );
};

// The sign-in gate and pending-action resume are mounted once in AppShell.
const MainLayout = () => <MainLayoutInner />;

export default MainLayout;
