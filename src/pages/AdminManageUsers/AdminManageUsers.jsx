import React, { useState } from "react";
import { useQuery } from "react-query";
import useUserInfo from "../../hooks/useUserInfo";
import { Link } from "react-router-dom";
import { GrUserAdmin, GrTrash } from "react-icons/gr";
import { Pagination } from "react-pagination-bar";
import { userDisplayName, isIncompleteProfile } from "../../utils/displayName";
import Swal from "sweetalert2";
import toast from "react-hot-toast";
import useAuthContext from "../../hooks/useAuthContext";
import useAxiosSecure from "../../hooks/useAxiosSecure";
import AnimateText from "@moxy/react-animate-text";

const AdminManageUsers = () => {
  const [userFromDB, , , totalSpentArray] = useUserInfo();
  const { user, isAuthLoading } = useAuthContext();
  const [axiosSecure] = useAxiosSecure();

  // fetch all users data
  const {
    data: allUsers,
    isLoading: isUsersLoading,
    refetch,
  } = useQuery({
    enabled:
      !isAuthLoading &&
      user !== null &&
      user !== undefined &&
      (userFromDB?.admin === true || userFromDB?.role === "ADMIN"),
    queryKey: ["all-users"],
    queryFn: async () => {
      const res = await axiosSecure.get("/users");
      return res.data;
    },
  });

  // Handle Make Admin User
  const handleMakeAdmin = (id) => {
    axiosSecure
      .patch(`/users/${id}`, {
        role: "ADMIN",
      })
      .then((res) => {
        if (res.data.success) {
          toast.success("The user is now an Admin");
          refetch();
        }
      })
      // The server refuses to promote customer accounts (they sign in with an
      // emailed code, never a password). Say why instead of failing silently.
      .catch((e) => toast.error(e.response?.data?.error || "Could not change this user's role"));
  };

  // Handle delete user
  const handleDeleteUser = (id) => {
    Swal.fire({
      title: "BE CAREFUL!",
      text: "All information associated with this user will be removed.",
      icon: "warning",
      showCancelButton: true,
      confirmButtonColor: "#000",
      cancelButtonColor: "#ef4c53",
      confirmButtonText: "Yes, delete it!",
      customClass: {
        popup: "w-[85%] md:w-[32em] ml-14",
      },
    }).then((result) => {
      if (result.isConfirmed) {
        axiosSecure
          .delete(`/users/${id}`)
          .then((res) => {
            if (res.data.success) {
              Swal.fire({
                title: "Deletion Successful!",
                text: "All data associated with the user is deleted.",
                icon: "success",
              });
              refetch();
            }
          })
          .catch((e) => console.error(e));
      }
    });
  };

  // pagination settings
  const [currentPage, setCurrentPage] = useState(1);
  const pageProductLimit = 6;

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-background">
      {/* Top Bar */}
      <header className="h-20 flex items-center justify-between px-6 md:px-margin-desktop bg-background/80 backdrop-blur-md border-b border-outline-variant/30 z-40 shrink-0">
        <h2 className="font-display-lg text-headline-md text-primary">Users</h2>
      </header>

      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto p-4 md:p-margin-desktop custom-scrollbar">
        <div className="bg-surface-dim border border-secondary/20 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse min-w-[800px]">
              <thead>
                <tr className="border-b border-outline-variant/50 bg-surface-container-high/50">
                  <th className="px-6 py-4 font-label-caps text-outline text-[11px]">User</th>
                  <th className="px-6 py-4 font-label-caps text-outline text-[11px]">Registered</th>
                  <th className="px-6 py-4 font-label-caps text-outline text-[11px]">Country</th>
                  <th className="px-6 py-4 font-label-caps text-outline text-[11px]">Spent</th>
                  <th className="px-6 py-4 font-label-caps text-outline text-[11px] text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant/20">
                {isUsersLoading ? (
                  <tr>
                     <td colSpan="5" className="px-6 py-10 text-center text-outline">Loading users...</td>
                  </tr>
                ) : (
                  allUsers
                    ?.slice(
                      (currentPage - 1) * pageProductLimit,
                      currentPage * pageProductLimit
                    )
                    .map((user) => (
                      <tr key={user._id} className="hover:bg-white/40 transition-colors group">
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-3">
                            <img
                              src={user.photoURL || "/placeholder-user.png"}
                              alt=""
                              referrerPolicy="no-referrer"
                              className="w-10 h-10 rounded-full border border-outline-variant/30 object-cover"
                            />
                            <div>
                              <div className="flex items-center gap-2">
                                {/* OTP customers who abandoned step 3 have no
                                    name and no email — this rendered an empty
                                    cell, which looks like broken data rather
                                    than an incomplete signup. */}
                                <h4 className="font-medium text-on-surface">
                                  {userDisplayName(user)}
                                </h4>
                                {user?.role === "ADMIN" && (
                                  <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-primary/10 text-primary font-label-caps text-[10px]">
                                    Admin
                                  </span>
                                )}
                                {isIncompleteProfile(user) && (
                                  <span
                                    className="inline-flex items-center px-2 py-0.5 rounded-full bg-secondary/10 text-secondary font-label-caps text-[10px]"
                                    title="Verified their number but never submitted a name"
                                  >
                                    No name
                                  </span>
                                )}
                              </div>
                              <div className="text-[12px] text-outline mt-0.5">
                                {user.email || user.phone || "—"}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="px-6 py-4 text-sm text-on-surface-variant">
                          {user.createdAt ? String(user.createdAt).slice(0, 10) : "—"}
                        </td>
                        <td className="px-6 py-4 text-sm text-on-surface-variant">
                          {user.shippingAddress
                            ? user.shippingAddress?.country
                            : "-Not Added-"}
                        </td>
                        <td className="px-6 py-4 font-medium text-on-surface">
                          {/* Keyed on user id, matching the aggregation.
                              Matching on email attributed spend wrongly: OTP
                              customers have no email, so `item.email ===
                              user.email` held for every one of them and they
                              all showed the same total. String() on both sides
                              because the id is an ObjectId in Mongo and a
                              string in the JSON that reaches here. */}
                          ₹
                          {(
                            totalSpentArray?.find(
                              (item) => String(item.userId) === String(user._id)
                            )?.totalSpent || 0
                          ).toFixed(2)}
                        </td>
                        <td className="px-6 py-4 text-right">
                          <div className="flex items-center justify-end gap-2">
                            {user.role !== "ADMIN" && (
                              <div className="tooltip" data-tip="Make Admin">
                                <button
                                  type="button"
                                  aria-label={`Make ${userDisplayName(user)} an admin`}
                                  className="inline-flex items-center justify-center w-11 h-11 rounded text-outline hover:text-primary hover:bg-surface-container transition-colors"
                                  onClick={() => handleMakeAdmin(user._id)}
                                >
                                  <GrUserAdmin className="text-lg" />
                                </button>
                              </div>
                            )}

                            <div className="tooltip" data-tip="Remove User">
                              <button
                                type="button"
                                aria-label={`Remove ${userDisplayName(user)}`}
                                className="inline-flex items-center justify-center w-11 h-11 rounded text-error/70 hover:text-error hover:bg-error-container/50 transition-colors"
                                onClick={() => handleDeleteUser(user._id)}
                              >
                                <GrTrash className="text-lg" />
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    ))
                )}
              </tbody>
            </table>
          </div>

          <div className="p-4 border-t border-outline-variant/20 bg-surface-container-low/30">
            <p className="text-[11px] text-outline mb-4">
              Showing {currentPage > 1 ? currentPage - 1 : currentPage}
              {currentPage > 1 && allUsers?.length > 10 && "1"} to{" "}
              {Math.ceil(allUsers?.length / 10) === currentPage
                ? allUsers?.length % 10 !== 0
                  ? (currentPage - 1) * 10 + (allUsers?.length % 10)
                  : currentPage * 10
                : currentPage * 10}{" "}
              of {allUsers?.length}
            </p>
            <Pagination
              currentPage={currentPage}
              totalItems={allUsers?.length}
              onPageChange={(pageNumber) => setCurrentPage(pageNumber)}
              itemsPerPage={pageProductLimit}
              pageNeighbours={3}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default AdminManageUsers;
