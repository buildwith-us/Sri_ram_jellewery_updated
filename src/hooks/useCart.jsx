import React from "react";
import { useQuery } from "react-query";
import useAuthContext from "./useAuthContext";
import toast from "react-hot-toast";
import useAxiosSecure from "./useAxiosSecure";

const useCart = () => {
  const { user, isAuthLoading } = useAuthContext();
  const [axiosSecure] = useAxiosSecure();

  const hasValidQuery = !isAuthLoading && user !== null && user !== undefined;

  const {
    data: cartData,
    isLoading: isQueryLoading,
    refetch,
  } = useQuery({
    enabled: hasValidQuery,
    queryKey: ["cart", user?._id || user?.email],
    queryFn: async () => {
      const res = await axiosSecure.get("/cart");
      return res.data;
    },
  });

  const isCartLoading = isAuthLoading || (hasValidQuery && isQueryLoading);

  // Totals derived from cartData, whose prices the server already recomputed
  // from the live metal rate on read — so this sums current prices, not the
  // ones captured when each item was added.
  //
  // gstAmount is the tax *inside* that total, not an addition to it: every
  // price computePrice returns is GST-inclusive, so the tax is taken back out
  // per line using the rate the server sends alongside it.
  const cartSubtotal = cartData?.reduce(
    (acc, item) => {
      const line = (item.price || item.discountPrice || 0) * (item.quantity || 1);
      const rate = Number(item.gstPercent) || 0;
      acc.subtotal += line;
      acc.gstAmount += rate > 0 ? line - line / (1 + rate / 100) : 0;
      return acc;
    },
    { subtotal: 0, gstAmount: 0 }
  ) || { subtotal: 0, gstAmount: 0 };

  // post product data to cart
  const addToCart = async (productData, quantity = 1) => {
    if (!isAuthLoading && user) {
      const { _id, productId, name, img, image, category, price, discountPrice } = productData;

      const cartProductData = {
        productId: productId || _id,
        name,
        img: img || image,
        image: img || image,
        category,
        price: discountPrice || price,
        quantity,
      };

      axiosSecure
        .post("/cart", cartProductData)
        .then((res) => {
          if (res.data?.insertedId || res.data?.success) {
            toast.success("Cart Updated", {
              position: "bottom-right",
            });
            refetch();
          }
        })
        // e.g. the 99-per-line limit: say why instead of failing silently.
        .catch((error) => toast.error(error.response?.data?.error || "Could not add this to your bag"));
    }
  };

  const updateCartQuantity = async (itemId, quantity) => {
    if (!isAuthLoading && user) {
      axiosSecure.patch(`/cart/${itemId}`, { quantity }).then((res) => {
        if (res.data?.success) {
          refetch();
          // We don't want a toast every time they click + or -, so we omit toast or use a subtle one
        }
      });
    }
  };

  return { cartData, isCartLoading, refetch, addToCart, updateCartQuantity, cartSubtotal };
};

export default useCart;
