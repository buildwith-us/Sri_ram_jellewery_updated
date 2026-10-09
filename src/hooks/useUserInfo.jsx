import React from "react";
import { useQuery } from "react-query";
import useAuthContext from "./useAuthContext";
import useAxiosSecure from "./useAxiosSecure";

const useUserInfo = () => {
  const { user, isAuthLoading } = useAuthContext();
  const [axiosSecure] = useAxiosSecure();

  const hasValidQuery = !isAuthLoading && user !== null && user !== undefined;

  const {
    data: userFromDB,
    isLoading: isQueryLoading,
    refetch,
  } = useQuery({
    enabled: hasValidQuery,
    queryKey: ["user", user?._id || user?.email],
    queryFn: async () => {
      const res = await axiosSecure.get("/users/me");
      return res.data?.data || res.data;
    },
  });

  const isUserLoading = isAuthLoading || (hasValidQuery && isQueryLoading);

  // Attach admin flag for backward compatibility
  const enrichedUser = React.useMemo(() => {
    return userFromDB
      ? { ...userFromDB, admin: userFromDB.role === "ADMIN" }
      : null;
  }, [userFromDB]);

  // Per-customer totals used to be fetched here, for every page and every
  // component using this hook whenever an admin was signed in — about ten
  // requests per admin page for a figure one page showed. The users list now
  // carries them (GET /api/users).
  return [enrichedUser, isUserLoading, refetch];
};

export default useUserInfo;
