import React from "react";
import { Outlet } from "react-router-dom";
import { Toaster } from "react-hot-toast";
import { LoginGateProvider } from "../context/LoginGateContext";
import useResumePendingAction from "../hooks/useResumePendingAction";

/**
 * The one element above every page — main site, product pages and dashboard.
 *
 * The sign-in gate lives here, once, rather than in each layout: the modal, its
 * once-per-session timer and the pending action then survive moving between
 * the three route trees (each used to mount its own copy, which reset the
 * timer and remounted the prompt on every cross-layout navigation).
 *
 * So does the one <Toaster>. MainLayout and DashboardLayout each had their own
 * and ProductPageLayout had none, so every toast on a product page (signed
 * in, added to bag, signed out) was silently dropped. It sits inside the
 * router, so a toast may still contain a <Link>.
 */
const ResumePendingAction = () => {
  useResumePendingAction();
  return null;
};

const AppShell = () => (
  <LoginGateProvider>
    <ResumePendingAction />
    <Outlet />
    <Toaster
      position="top-center"
      toastOptions={{
        className: "font-bold py-8",
        style: {
          fontFamily: "var(--poppins)",
          padding: "15px 20px",
          maxWidth: "max-content",
        },
      }}
    />
  </LoginGateProvider>
);

export default AppShell;
