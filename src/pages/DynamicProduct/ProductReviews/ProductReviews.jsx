import React, { useEffect, useState, useCallback } from "react";
import { useLocation, useParams } from "react-router-dom";
import useProducts from "../../../hooks/useProducts";
import useDynamicRating from "../../../hooks/useDynamicRating";
import StarRatings from "react-star-ratings";
import { Link } from "react-router-dom";
import useAuthContext from "../../../hooks/useAuthContext";
import useUserInfo from "../../../hooks/useUserInfo";
import toast from "react-hot-toast";
import useAxiosSecure from "../../../hooks/useAxiosSecure";
import TimeAgo from "../../../components/TimeAgo/TimeAgo";

const ProductReviews = () => {
  const { id } = useParams();
  const { user } = useAuthContext();
  const [userFromDB] = useUserInfo();
  const [axiosSecure] = useAxiosSecure();
  const [products] = useProducts();
  const [dynamicProduct, setDynamicProduct] = useState(null);
  const [reviews, setReviews] = useState([]);
  const [isReviewsLoading, setIsReviewsLoading] = useState(true);
  const [showAllReviews, setShowAllReviews] = useState(false);
  const [reviewsLength, setReviewsLength] = useState(2);
  const location = useLocation();
  const [productReviewError, setProductReviewError] = useState("");
  const { averageRating } = useDynamicRating(reviews);

  // fetch dynamic product data
  useEffect(() => {
    const found = products?.find((p) => p._id === id);
    setDynamicProduct(found);
  }, [id, products]);

  const productIdentifier = dynamicProduct?.productId || dynamicProduct?._id;

  const fetchReviews = useCallback(() => {
    if (!productIdentifier) return;
    setIsReviewsLoading(true);
    axiosSecure
      .get(`/reviews/${productIdentifier}`)
      .then((res) => {
        setReviews(res.data?.data || []);
      })
      .catch((error) => {
        console.error(error);
      })
      .finally(() => setIsReviewsLoading(false));
  }, [axiosSecure, productIdentifier]);

  useEffect(() => {
    fetchReviews();
  }, [fetchReviews]);

  // `mine` comes from the API, which no longer publishes reviewers' userIds.
  const hasUserReviewed = !!(user && reviews.some((r) => r.mine));

  const handleShowReviews = () => setShowAllReviews((v) => !v);
  useEffect(() => {
    setReviewsLength(showAllReviews ? reviews.length : 2);
  }, [showAllReviews, reviews.length]);

  const [starRating, setStarRating] = useState(0);

  const handleSubmitProductReview = (e) => {
    e.preventDefault();
    setProductReviewError("");

    if (!starRating) {
      setProductReviewError("Rating value is required");
      return;
    }

    const form = e.target;
    const reviewText = form.reviewText.value;

    axiosSecure
      .post("/reviews", {
        productId: productIdentifier,
        productName: dynamicProduct?.name,
        name: userFromDB?.name || user?.name || "Anonymous",
        review: reviewText,
        rating: starRating,
      })
      .then(() => {
        toast.success("Review Added", { position: "bottom-right" });
        form.reset();
        setStarRating(0);
        setProductReviewError("");
        fetchReviews();
      })
      .catch((error) => {
        setProductReviewError(error?.response?.data?.error || "Failed to submit review");
      });
  };

  const deleteProductReview = (reviewId) => {
    axiosSecure
      .delete(`/reviews/${reviewId}`)
      .then(() => {
        toast.success("Review removed");
        fetchReviews();
      })
      .catch((error) => console.error(error));
  };

  return (
    <div className="py-16 px-4 md:px-12 flex flex-col gap-16 border-b border-outline-variant/30 max-w-4xl mx-auto" id="productReviews">
      <div className="flex flex-col items-center justify-center p-12 bg-surface-container-low border border-outline-variant/30 rounded-sm">
        <h1 className="font-display-lg text-6xl text-primary mb-4">{averageRating}</h1>
        <StarRatings
          rating={averageRating}
          starDimension="24px"
          starSpacing="4px"
          starRatedColor="#c8a684"
          starEmptyColor="#ebe1d2"
        />
        <p className="font-label-caps text-xs text-on-surface-variant uppercase tracking-widest mt-6">Product Rating</p>
      </div>

      {!isReviewsLoading && reviews.length > 0 && (
        <div className="space-y-12">
          <h4 className="font-display-lg text-headline-sm text-primary text-center">
            CLIENT FEEDBACK
          </h4>

          <div className="space-y-10">
            {reviews.slice(0, reviewsLength).map((r) => (
              <div key={r._id} className="flex items-start gap-6 pb-10 border-b border-outline-variant/20 last:border-0">
                <div className="w-12 h-12 rounded-full overflow-hidden shrink-0 border border-outline-variant/30">
                  <img src={"https://ui-avatars.com/api/?name=" + r.name} alt={r.name} className="w-full h-full object-cover" />
                </div>

                <div className="flex-1 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      <h5 className="font-display-lg text-lg text-primary">
                        {r.name}
                      </h5>
                      <p className="font-label-caps text-[10px] text-on-surface-variant uppercase tracking-widest">
                        <TimeAgo timestamp={r.date} />
                      </p>
                    </div>

                    {user && r.mine && (
                      <button onClick={() => deleteProductReview(r._id)} className="text-on-surface-variant hover:text-error transition-colors" title="Delete Review">
                        <span className="material-symbols-outlined text-sm">delete</span>
                      </button>
                    )}
                  </div>

                  <StarRatings
                    rating={r.rating}
                    starDimension="14px"
                    starSpacing="2px"
                    starRatedColor="#c8a684"
                    starEmptyColor="#ebe1d2"
                  />

                  <p className="font-body-base text-on-surface-variant leading-relaxed text-sm">{r.review}</p>
                </div>
              </div>
            ))}
          </div>

          {reviews.length > 2 && (
            <button
              onClick={handleShowReviews}
              className="mx-auto flex items-center justify-center gap-2 font-label-caps text-xs text-primary uppercase tracking-widest hover:bg-primary/5 px-6 py-3 border border-primary/20 transition-colors rounded-sm"
            >
              {showAllReviews ? "Show Less" : "View All Reviews"}
            </button>
          )}
        </div>
      )}

      <div className="pt-8 mt-8 border-t border-outline-variant/30">
        {!user ? (
          <div className="text-center bg-surface-container-low p-10 border border-outline-variant/30">
            <h4 className="font-display-lg text-headline-sm text-primary mb-4">
              Write a Review
            </h4>
            <p className="font-body-base text-on-surface-variant">
              You must be{" "}
              <Link
                to="/login"
                className="text-primary font-bold border-b border-primary/30 hover:border-primary transition-colors"
                state={{ from: location }}
              >
                logged in
              </Link>{" "}
              to write a review.
            </p>
          </div>
        ) : (
          <>
            {!hasUserReviewed && (
              <div className="bg-surface-container-low p-8 md:p-12 border border-outline-variant/30 rounded-sm">
                <h4 className="font-display-lg text-headline-sm text-primary mb-8 text-center">Share Your Experience</h4>
                <form
                  onSubmit={handleSubmitProductReview}
                  className="space-y-8 max-w-2xl mx-auto"
                >
                  {productReviewError && (
                    <p className="text-error font-body-base text-sm bg-error-container text-on-error-container p-4 rounded-sm">{productReviewError}</p>
                  )}

                  <div className="space-y-3 flex flex-col items-center">
                    <h5 className="font-label-caps text-xs text-on-surface-variant uppercase tracking-widest">
                      Rate this product
                    </h5>
                    <StarRatings
                      rating={starRating}
                      starRatedColor="#c8a684"
                      starHoverColor="#c8a684"
                      starEmptyColor="#ebe1d2"
                      changeRating={setStarRating}
                      numberOfStars={5}
                      starDimension="28px"
                      starSpacing="4px"
                    />
                  </div>

                  <div className="space-y-3">
                    <label className="font-label-caps text-xs text-on-surface-variant uppercase tracking-widest">Your Review</label>
                    <textarea
                      rows={5}
                      required
                      name="reviewText"
                      placeholder="Share what you liked about the piece..."
                      className="w-full bg-surface border border-outline-variant/50 px-4 py-3 text-sm focus:border-primary focus:ring-1 focus:ring-primary outline-none transition-ui rounded-sm font-body-base"
                      minLength={10}
                    />
                  </div>

                  <button className="w-full bg-primary text-white py-4 font-button-text uppercase tracking-widest hover:bg-primary-container transition-colors rounded-sm">
                    Submit Review
                  </button>
                </form>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default ProductReviews;
