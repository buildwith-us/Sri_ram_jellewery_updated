import React, { useEffect } from "react";
import ProductPageNavigation from "../pages/DynamicProduct/ProductPageNavigation/ProductPageNavigation";
import { Outlet, useParams } from "react-router-dom";
import DynamicProduct from "../pages/DynamicProduct/DynamicProduct";
import RelatedDynamicProducts from "../pages/RelatedDynamicProducts/RelatedDynamicProducts";
import Header from "../pages/Header/Header";
import Footer from "../pages/Footer/Footer";

const ProductPageLayoutInner = () => {
  const { id } = useParams();

  // Arriving here from a scrolled shop grid otherwise keeps that scroll offset,
  // dropping the customer part-way down the product page. MainLayout's
  // scroll-to-top does not cover this: it skips any path containing
  // "description", and this layout is a separate root route anyway.
  //
  // Keyed on the product id, not the pathname, so switching between the
  // Description and Reviews tabs — which is what that skip was protecting —
  // still leaves the reader where they were.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [id]);

  return (
    <div className="font-body-base bg-background text-on-surface min-h-screen w-full flex flex-col">
      <Header />
      <DynamicProduct />

      <div className="w-full bg-surface-container-low/30 border-t border-outline-variant/30">
        <ProductPageNavigation />
      </div>

      <div className="max-w-container-max mx-auto px-margin-mobile md:px-margin-desktop w-full">
        <Outlet />
      </div>

      <RelatedDynamicProducts />
      <Footer />
    </div>
  );
};

// This layout is a separate root route (not nested under MainLayout), so it
// needs its own gate provider — otherwise the purchase actions on the product
// page fall back to a no-op and silently do nothing.
// The sign-in gate and pending-action resume are mounted once in AppShell.
const ProductPageLayout = () => <ProductPageLayoutInner />;

export default ProductPageLayout;
