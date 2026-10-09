import React from "react";
import DashboardNav from "../pages/Dashboard/DashboardNav/DashboardNav";
import { Outlet } from "react-router-dom";
import CustomHelmet from "../components/CustomHelmet/CustomHelmet";
import useUserInfo from "../hooks/useUserInfo";
import AdminNavigation from "../pages/Dashboard/AdminNavigation/AdminNavigation";
import useAuthContext from "../hooks/useAuthContext";
import Header from "../pages/Header/Header";
import Footer from "../pages/Footer/Footer";

const DashboardLayoutInner = () => {

  const [userFromDB, isUserLoading] = useUserInfo();
  const { user, isAuthLoading } = useAuthContext();

  return (
    <div className="font-body-base bg-surface text-on-surface min-h-screen flex flex-col overflow-x-hidden">
      <CustomHelmet title={"My Account | Sri Ram Jewellery"} />

      <>
        {!isAuthLoading && user && (
          <>
            {!isUserLoading && (userFromDB?.admin || userFromDB?.role === "ADMIN") ? (
              <div className="flex h-screen w-full overflow-hidden">
                <AdminNavigation />
                <main className="flex-1 h-full flex flex-col overflow-hidden bg-background pt-16 lg:pt-0">
                  <Outlet />
                </main>
              </div>
            ) : (
              <div className="flex-grow flex flex-col">
                <Header />
                <div className="flex-grow max-w-container-max mx-auto w-full px-margin-mobile md:px-margin-desktop pt-32 pb-12 md:pt-40 md:pb-24 relative flex flex-col md:flex-row gap-12">
                  <DashboardNav />
                  <main className="flex-1 w-full overflow-hidden fade-in">
                    <Outlet />
                  </main>
                </div>
                <Footer />
              </div>
            )}
          </>
        )}
      </>
      
    </div>
  );
};

// The sign-in gate and pending-action resume are mounted once in AppShell.
const DashboardLayout = () => <DashboardLayoutInner />;

export default DashboardLayout;
