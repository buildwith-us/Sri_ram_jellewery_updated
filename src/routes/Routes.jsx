import React from "react";
import { createBrowserRouter, Navigate } from "react-router-dom";
import MainLayout from "../layouts/MainLayout";
import ErrorPage from "../pages/ErrorPage/ErrorPage";
import Home from "../pages/Home/Home";
import Login from "../pages/Login/Login";
import AdminLogin from "../pages/AdminLogin/AdminLogin";
import Register from "../pages/Register/Register";
import ProductPageLayout from "../layouts/ProductPageLayout";
import ProductDescription from "../pages/DynamicProduct/ProductDescription/ProductDescription";
import ProductReviews from "../pages/DynamicProduct/ProductReviews/ProductReviews";
import Shop from "../pages/Shop/Shop/Shop";
import Contact from "../pages/Contact/Contact";
import AdminMessages from "../pages/Dashboard/AdminMessages/AdminMessages";
import AdminSubscribers from "../pages/Dashboard/AdminSubscribers/AdminSubscribers";
import Wishlist from "../pages/Wishlist/Wishlist";
import PrivateRoute from "./PrivateRoute/PrivateRoute";
import DashboardLayout from "../layouts/DashboardLayout";
import AppShell from "../layouts/AppShell";
import CategoryGold from "../pages/CategoryGold/CategoryGold";
import MyDashboard from "../pages/Dashboard/MyDashboard/MyDashboard";
import MyOrders from "../pages/Dashboard/MyOrders/MyOrders";
import AddressBook from "../pages/Dashboard/AddressBook/AddressBook";
import AccountDetails from "../pages/Dashboard/AccountDetails/AccountDetails";
import Checkout from "../pages/Checkout/Checkout";
import OrderSuccess from "../pages/OrderSuccess/OrderSuccess";
import AddReview from "../pages/Dashboard/AddReview/AddReview";
import AdminDashboard from "../pages/Dashboard/AdminDashboard/AdminDashboard";
import AdminRoute from "./AdminRoute/AdminRoute";
import DashboardIndexRedirect from "./DashboardIndexRedirect";
import AdminProducts from "../pages/Dashboard/AdminProducts/AdminProducts";
import AdminAddProduct from "../pages/Dashboard/AdminAddProduct/AdminAddProduct";
import AdminManageUsers from "../pages/AdminManageUsers/AdminManageUsers";
import AdminCategories from "../pages/AdminCategories/AdminCategories";
import AdminOrders from "../pages/Dashboard/AdminOrders/AdminOrders";
import AdminQuoteRequests from "../pages/Dashboard/AdminQuoteRequests/AdminQuoteRequests";
import AdminLiveRates from "../pages/Dashboard/AdminLiveRates/AdminLiveRates";
import About from "../pages/About/About";
import LegalIndex from "../pages/Legal/LegalIndex";
import LegalPage from "../components/LegalPage/LegalPage";
import HelpCenter from "../pages/HelpCenter/HelpCenter";
import Forbidden from "../pages/Forbidden/Forbidden";
import PaymentFailed from "../pages/PaymentFailed/PaymentFailed";
import PaymentPending from "../pages/PaymentPending/PaymentPending";
import Onboarding from "../pages/Onboarding/Onboarding";
import Billing from "../pages/Dashboard/Billing/Billing";
import ForgotPassword from "../pages/ForgotPassword/ForgotPassword";
import ResetPassword from "../pages/ResetPassword/ResetPassword";

const router = createBrowserRouter([
  {
    // Pathless parent: mounts the sign-in gate once for every route below.
    element: <AppShell />,
    errorElement: <ErrorPage />,
    children: [
  {
    path: "/",
    element: <MainLayout />,
    errorElement: <ErrorPage />,
    children: [
      {
        path: "/",
        element: <Home />,
      },
      {
        path: "shop",
        element: <Shop />,
      },
      {
        path: "categories",
        element: <CategoryGold />,
      },
      {
        path: "login",
        element: <Login />,
      },
      {
        path: "admin-login",
        element: <AdminLogin />,
      },
      // Both public by necessity — the whole point is being reachable while
      // locked out of the account.
      {
        path: "forgot-password",
        element: <ForgotPassword />,
      },
      {
        path: "reset-password",
        element: <ResetPassword />,
      },
      {
        path: "register",
        element: <Register />,
      },
      {
        path: "about",
        element: <About />,
      },
      {
        path: "contact",
        element: <Contact />,
      },
      {
        path: "wishlist",
        element: (
          <Navigate to="/dashboard/wishlist" replace />
        ),
      },
      {
        path: "checkout",
        element: (
          <PrivateRoute>
            <Checkout />
          </PrivateRoute>
        ),
      },
      {
        path: "order-success",
        element: (
          <PrivateRoute>
            <OrderSuccess />
          </PrivateRoute>
        ),
      },
      // Payment outcomes are distinct destinations, not one page with a flag —
      // each needs its own next action, and "pending" must not offer a retry.
      {
        path: "payment-failed",
        element: (
          <PrivateRoute>
            <PaymentFailed />
          </PrivateRoute>
        ),
      },
      {
        path: "payment-pending",
        element: (
          <PrivateRoute>
            <PaymentPending />
          </PrivateRoute>
        ),
      },
      {
        path: "welcome",
        element: (
          <PrivateRoute>
            <Onboarding />
          </PrivateRoute>
        ),
      },
      {
        path: "help",
        element: <HelpCenter />,
      },
      {
        path: "legal",
        element: <LegalIndex />,
      },
      {
        // One route serves all ten policies from the content model.
        path: "legal/:slug",
        element: <LegalPage />,
      },
      {
        path: "403",
        element: <Forbidden />,
      },
    ],
  },
  {
    path: "/dashboard",
    element: (
      <PrivateRoute>
        <DashboardLayout />
      </PrivateRoute>
    ),
    children: [
      {
        index: true,
        element: <DashboardIndexRedirect />,
      },
      {
        path: "myDashboard",
        element: <MyDashboard />,
      },
          {
            path: "myOrders",
            element: <MyOrders />,
          },
          {
            path: "myAddress",
            element: <AddressBook />,
          },
          {
            path: "addReview",
            element: <AddReview />,
          },
          {
            path: "billing",
            element: <Billing />,
          },
          {
            path: "accountDetails",
            element: <AccountDetails />,
          },
          {
            path: "wishlist",
            element: <Wishlist />,
          },
          {
            path: "adminDashboard",
            element: (
              <AdminRoute>
                <AdminDashboard />
              </AdminRoute>
            ),
          },
          {
            path: "adminCategories",
            element: (
              <AdminRoute>
                <AdminCategories />
              </AdminRoute>
            ),
          },
          {
            path: "adminProducts",
            element: (
              <AdminRoute>
                <AdminProducts />
              </AdminRoute>
            ),
          },

          {
            path: "adminAddProducts",
            element: (
              <AdminRoute>
                <AdminAddProduct />
              </AdminRoute>
            ),
          },
          {
            path: "adminAddProducts/:id",
            element: (
              <AdminRoute>
                <AdminAddProduct />
              </AdminRoute>
            ),
          },
          {
            path: "adminUsers",
            element: (
              <AdminRoute>
                <AdminManageUsers />
              </AdminRoute>
            ),
          },
          {
            path: "adminMessages",
            element: (
              <AdminRoute>
                <AdminMessages />
              </AdminRoute>
            ),
          },
          {
            path: "adminSubscribers",
            element: (
              <AdminRoute>
                <AdminSubscribers />
              </AdminRoute>
            ),
          },
          {
            path: "adminOrders",
            element: (
              <AdminRoute>
                <AdminOrders />
              </AdminRoute>
            ),
          },
          {
            path: "adminQuoteRequests",
            element: (
              <AdminRoute>
                <AdminQuoteRequests />
              </AdminRoute>
            ),
          },
          {
            path: "adminLiveRates",
            element: (
              <AdminRoute>
                <AdminLiveRates />
              </AdminRoute>
            ),
          },
        ],
      },

      {
        path: "products/:id",
        element: <ProductPageLayout />,
        children: [
          {
            index: true,
            element: <Navigate to="description" replace />,
          },
          {
            path: "description",
            element: <ProductDescription />,
          },
          {
            path: "reviews",
            element: <ProductReviews />,
          },
        ],
      },
    ],
  },
]);

export default router;
