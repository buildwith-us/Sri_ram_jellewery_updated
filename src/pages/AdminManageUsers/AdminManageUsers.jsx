import React, { useMemo, useState } from "react";
import { useQuery } from "react-query";
import useUserInfo from "../../hooks/useUserInfo";
import { GrUserAdmin, GrTrash } from "react-icons/gr";
import { Pagination } from "react-pagination-bar";
import { userDisplayName } from "../../utils/displayName";
import Swal from "sweetalert2";
import toast from "react-hot-toast";
import useAuthContext from "../../hooks/useAuthContext";
import useAxiosSecure from "../../hooks/useAxiosSecure";

const PAGE_SIZE = 10;

const SORTS = {
  joined_desc: { label: "Newest first", by: (u) => new Date(u.createdAt || 0).getTime(), dir: -1 },
  joined_asc: { label: "Oldest first", by: (u) => new Date(u.createdAt || 0).getTime(), dir: 1 },
  spent_desc: { label: "Highest spend", by: (u) => u.totalSpent || 0, dir: -1 },
  spent_asc: { label: "Lowest spend", by: (u) => u.totalSpent || 0, dir: 1 },
};

const rupees = (n) => `₹${Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

const joinedOn = (value) =>
  value ? new Date(value).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—";

/** +919876543210 → +91 98765 43210, for reading aloud on a call. */
const formatPhone = (phone) => {
  const national = String(phone || "").replace(/^\+91/, "");
  return /^\d{10}$/.test(national) ? `+91 ${national.slice(0, 5)} ${national.slice(5)}` : String(phone || "");
};

const digits = (s) => String(s || "").replace(/\D/g, "");

/**
 * Does this row match the search? Name and email by text; the phone by its
 * digits, so "98765 43210", "+91 98765…" and "09876543210" all find it.
 */
const matches = (u, query) => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (String(u.name || "").toLowerCase().includes(q)) return true;
  if (String(u.email || "").toLowerCase().includes(q)) return true;
  const d = digits(q).replace(/^(91|0)(?=\d{10}$)/, "");
  return d.length >= 3 && digits(u.phone).includes(d);
};

/** The number the owner calls about delivery — a tap dials it on a phone. */
const PhoneLink = ({ phone }) =>
  phone ? (
    <a
      href={`tel:${phone}`}
      className="inline-flex items-center gap-1.5 min-h-11 text-primary font-medium hover:underline whitespace-nowrap"
      aria-label={`Call ${formatPhone(phone)}`}
    >
      <span className="material-symbols-outlined text-[18px]" aria-hidden="true">call</span>
      {formatPhone(phone)}
    </a>
  ) : (
    <span className="text-outline text-sm whitespace-nowrap">No phone yet</span>
  );

const RoleBadge = ({ user }) =>
  user.role === "ADMIN" ? (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-primary/10 text-primary font-label-caps text-[10px]">
      Admin
    </span>
  ) : null;

/**
 * Users, for the owner: who each customer is, how to reach them, when they
 * joined, how many orders they have placed and what they have spent (revenue
 * by the one definition — utils/revenue.js). Everything comes from
 * GET /api/users, which returns only those fields.
 */
const AdminManageUsers = () => {
  const [userFromDB] = useUserInfo();
  const { user, isAuthLoading } = useAuthContext();
  const [axiosSecure] = useAxiosSecure();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("joined_desc");
  const [currentPage, setCurrentPage] = useState(1);

  const {
    data: allUsers,
    isLoading: isUsersLoading,
    refetch,
  } = useQuery({
    enabled: !isAuthLoading && Boolean(user) && (userFromDB?.admin === true || userFromDB?.role === "ADMIN"),
    queryKey: ["all-users"],
    queryFn: async () => (await axiosSecure.get("/users")).data,
  });

  const rows = useMemo(() => {
    const { by, dir } = SORTS[sort];
    return (allUsers || []).filter((u) => matches(u, query)).sort((a, b) => (by(a) - by(b)) * dir);
  }, [allUsers, query, sort]);

  const pageRows = rows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const first = rows.length ? (currentPage - 1) * PAGE_SIZE + 1 : 0;
  const last = Math.min(currentPage * PAGE_SIZE, rows.length);

  const onSearch = (value) => {
    setQuery(value);
    setCurrentPage(1);
  };
  const onSort = (value) => {
    setSort(value);
    setCurrentPage(1);
  };
  /** The column headers sort too: first click descending, then ascending. */
  const toggleSort = (column) => onSort(sort === `${column}_desc` ? `${column}_asc` : `${column}_desc`);
  const ariaSort = (column) =>
    sort === `${column}_desc` ? "descending" : sort === `${column}_asc` ? "ascending" : "none";

  const handleMakeAdmin = (id) => {
    axiosSecure
      .patch(`/users/${id}`, { role: "ADMIN" })
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

  const handleDeleteUser = (id) => {
    Swal.fire({
      title: "BE CAREFUL!",
      text: "All information associated with this user will be removed.",
      icon: "warning",
      showCancelButton: true,
      confirmButtonColor: "#000",
      cancelButtonColor: "#ef4c53",
      confirmButtonText: "Yes, delete it!",
      customClass: { popup: "w-[85%] md:w-[32em]" },
    }).then((result) => {
      if (!result.isConfirmed) return;
      axiosSecure
        .delete(`/users/${id}`)
        .then((res) => {
          if (res.data.success) {
            Swal.fire({ title: "Deletion Successful!", text: "All data associated with the user is deleted.", icon: "success" });
            refetch();
          }
        })
        .catch((e) => toast.error(e.response?.data?.error || "Could not remove this user"));
    });
  };

  const Actions = ({ row }) => (
    <div className="flex items-center justify-end gap-2">
      {row.role !== "ADMIN" && (
        <div className="tooltip" data-tip="Make Admin">
          <button
            type="button"
            aria-label={`Make ${userDisplayName(row)} an admin`}
            className="inline-flex items-center justify-center w-11 h-11 rounded text-outline hover:text-primary hover:bg-surface-container transition-colors"
            onClick={() => handleMakeAdmin(row._id)}
          >
            <GrUserAdmin className="text-lg" />
          </button>
        </div>
      )}
      <div className="tooltip" data-tip="Remove User">
        <button
          type="button"
          aria-label={`Remove ${userDisplayName(row)}`}
          className="inline-flex items-center justify-center w-11 h-11 rounded text-error/70 hover:text-error hover:bg-error-container/50 transition-colors"
          onClick={() => handleDeleteUser(row._id)}
        >
          <GrTrash className="text-lg" />
        </button>
      </div>
    </div>
  );

  const name = (row) => (row.name ? row.name : <span className="text-outline italic">No name</span>);
  const th = "px-4 py-4 font-label-caps text-outline text-[11px] whitespace-nowrap";
  const sortHeader = (column, label, align = "") => (
    <th className={`${th} ${align}`} aria-sort={ariaSort(column)}>
      <button
        type="button"
        onClick={() => toggleSort(column)}
        className="inline-flex items-center gap-1 min-h-11 hover:text-primary cursor-pointer"
      >
        {label}
        <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
          {ariaSort(column) === "ascending" ? "arrow_upward" : ariaSort(column) === "descending" ? "arrow_downward" : "unfold_more"}
        </span>
      </button>
    </th>
  );

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-background">
      <header className="h-20 flex items-center justify-between px-4 md:px-margin-desktop bg-background/80 backdrop-blur-md border-b border-outline-variant/30 z-40 shrink-0">
        <h2 className="font-display-lg text-headline-md text-primary">Users</h2>
      </header>

      <div className="flex-1 overflow-y-auto p-4 md:p-margin-desktop custom-scrollbar">
        {/* Search and sort */}
        <div className="flex flex-col md:flex-row gap-3 md:items-end mb-6">
          <label className="flex-1 block">
            <span className="font-label-caps text-[11px] text-outline uppercase tracking-widest block mb-1">Search</span>
            <input
              type="search"
              value={query}
              onChange={(e) => onSearch(e.target.value)}
              placeholder="Name, email or phone"
              aria-label="Search users by name, email or phone"
              className="w-full min-h-11 px-3 bg-surface border border-outline-variant/50 rounded focus:border-primary outline-none text-on-surface"
            />
          </label>
          <label className="block md:w-56">
            <span className="font-label-caps text-[11px] text-outline uppercase tracking-widest block mb-1">Sort by</span>
            <select
              value={sort}
              onChange={(e) => onSort(e.target.value)}
              aria-label="Sort users"
              className="w-full min-h-11 px-3 bg-surface border border-outline-variant/50 rounded focus:border-primary outline-none text-on-surface"
            >
              {Object.entries(SORTS).map(([key, { label }]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="bg-surface-dim border border-secondary/20 rounded-xl overflow-hidden">
          {isUsersLoading ? (
            <p className="px-6 py-10 text-center text-outline">Loading users...</p>
          ) : !rows.length ? (
            <p className="px-6 py-10 text-center text-outline">
              {query ? `No users match “${query}”.` : "No users yet."}
            </p>
          ) : (
            <>
              {/* Phones: one card per user, the number first-class and tappable. */}
              <ul className="md:hidden divide-y divide-outline-variant/20" aria-label="Users">
                {pageRows.map((row) => (
                  <li key={row._id} className="p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="font-medium text-on-surface break-words">{name(row)}</h3>
                          <RoleBadge user={row} />
                        </div>
                        <p className="text-[13px] text-on-surface-variant break-all">{row.email || "—"}</p>
                      </div>
                      <Actions row={row} />
                    </div>
                    <PhoneLink phone={row.phone} />
                    <dl className="grid grid-cols-3 gap-2 text-[12px] mt-1">
                      <div>
                        <dt className="text-outline">Joined</dt>
                        <dd className="text-on-surface">{joinedOn(row.createdAt)}</dd>
                      </div>
                      <div>
                        <dt className="text-outline">Orders</dt>
                        <dd className="text-on-surface">{row.orderCount}</dd>
                      </div>
                      <div>
                        <dt className="text-outline">Spent</dt>
                        <dd className="text-on-surface font-medium">{rupees(row.totalSpent)}</dd>
                      </div>
                    </dl>
                  </li>
                ))}
              </ul>

              {/* Tablet and up: the table. */}
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-outline-variant/50 bg-surface-container-high/50">
                      <th className={th}>Name</th>
                      <th className={th}>Email</th>
                      <th className={th}>Phone</th>
                      {sortHeader("joined", "Joined")}
                      <th className={`${th} text-right`}>Orders</th>
                      {sortHeader("spent", "Total spent", "text-right")}
                      <th className={`${th} text-right`}>
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-outline-variant/20">
                    {pageRows.map((row) => (
                      <tr key={row._id} className="hover:bg-white/40 transition-colors">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-on-surface">{name(row)}</span>
                            <RoleBadge user={row} />
                          </div>
                        </td>
                        <td className="px-4 py-3 text-sm text-on-surface-variant break-all">{row.email || "—"}</td>
                        <td className="px-4 py-3 text-sm">
                          <PhoneLink phone={row.phone} />
                        </td>
                        <td className="px-4 py-3 text-sm text-on-surface-variant whitespace-nowrap">{joinedOn(row.createdAt)}</td>
                        <td className="px-4 py-3 text-sm text-on-surface text-right">{row.orderCount}</td>
                        <td className="px-4 py-3 font-medium text-on-surface text-right whitespace-nowrap">{rupees(row.totalSpent)}</td>
                        <td className="px-4 py-3">
                          <Actions row={row} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <div className="p-4 border-t border-outline-variant/20 bg-surface-container-low/30">
            <p className="text-[11px] text-outline mb-4" aria-live="polite">
              {rows.length ? `Showing ${first}–${last} of ${rows.length}` : "Showing 0"}
              {query && allUsers?.length ? ` (of ${allUsers.length} users)` : ""}
            </p>
            {rows.length > PAGE_SIZE && (
              <Pagination
                currentPage={currentPage}
                totalItems={rows.length}
                onPageChange={(pageNumber) => setCurrentPage(pageNumber)}
                itemsPerPage={PAGE_SIZE}
                pageNeighbours={3}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default AdminManageUsers;
