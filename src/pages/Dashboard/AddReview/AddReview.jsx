import React, { useState } from "react";
import StarRatings from "react-star-ratings";
import useAuthContext from "../../../hooks/useAuthContext";
import useUserInfo from "../../../hooks/useUserInfo";
import toast from "react-hot-toast";
import { HashLink } from "react-router-hash-link";
import Swal from "sweetalert2";
import { useQuery } from "react-query";
import useAxiosSecure from "../../../hooks/useAxiosSecure";

const AddReview = () => {
  const { user, isAuthLoading } = useAuthContext();
  const [userFromDB] = useUserInfo();
  const [axiosSecure] = useAxiosSecure();
  const [productReviewError, setProductReviewError] = useState("");
  const [starRating, setStarRating] = useState(0);
  
  const handleRatingChange = (newRating) => {
    setStarRating(newRating);
    if(newRating > 0) setProductReviewError("");
  };
  
  const [userReview, setUserReview] = useState(null);

  const { refetch } = useQuery({
    queryKey: ["reviews"],
    enabled: !isAuthLoading && user !== null && user !== undefined,
    queryFn: async () => {
      const reviews = await axiosSecure.get("/reviews");
      // The API marks the reader's own reviews (it no longer publishes userId).
      const reviewByUser = (reviews.data || []).find((r) => r.mine);
      setUserReview(reviewByUser || null);
      return reviews.data;
    },
  });

  const handleSubmitProductReview = (e) => {
    e.preventDefault();
    setProductReviewError("");

    if (starRating === 0) {
      setProductReviewError("Please select a star rating");
      return;
    }

    const form = e.target;
    const review = form.review.value;
    const location = form.location.value;

    axiosSecure
      .post("/reviews", {
        name: userFromDB?.name || "Anonymous",
        location,
        review,
        rating: parseFloat(starRating),
      })
      .then((res) => {
        if (res.data.success) {
          refetch();
          toast.success("Feedback submitted successfully");
          form.reset();
        }
      })
      .catch((error) => {
        setProductReviewError(error?.response?.data?.error || "Failed to submit review");
      });
  };

  const handleDeleteReview = () => {
    Swal.fire({
      title: "Remove Review?",
      text: "Your feedback will be permanently removed from our testimonials.",
      icon: "warning",
      showCancelButton: true,
      confirmButtonColor: "#8B6447",
      cancelButtonColor: "#c8a684",
      confirmButtonText: "Yes, remove it",
    }).then((result) => {
      if (result.isConfirmed) {
        axiosSecure
          .delete(`/reviews/${userReview._id}`)
          .then((res) => {
            if (res.data.success) {
              refetch();
              toast.success("Review removed");
              setStarRating(0);
            }
          })
          .catch((error) => console.error(error));
      }
    });
  };

  return (
    <div className="w-full">
      <header className="mb-12">
        <span className="font-body text-[12px] font-semibold text-secondary tracking-[0.2em] uppercase block mb-2">
          Your Account
        </span>
        <h1 className="font-display text-5xl md:text-6xl text-primary">Write a Review</h1>
      </header>

      {!userReview ? (
        <div className="bg-surface-container-low border border-outline-gold/30 p-8 max-w-2xl animate-fade-in">
          <p className="font-body text-sm text-on-surface-variant mb-8 leading-relaxed">
            Your experiences shape our legacy. We invite you to share your thoughts on our craftsmanship, service, and the timeless pieces you've acquired.
          </p>

          <form onSubmit={handleSubmitProductReview} className="space-y-8">
            <div className="space-y-4">
              <label className="font-body text-[11px] font-semibold text-on-surface-variant uppercase tracking-[0.2em] block">
                Overall Experience *
              </label>
              <div className="flex items-center gap-4">
                <StarRatings
                  rating={starRating}
                  starRatedColor="#c8a684"
                  starHoverColor="#8B6447"
                  starEmptyColor="#ebe1d2"
                  changeRating={handleRatingChange}
                  numberOfStars={5}
                  starDimension="32px"
                  starSpacing="4px"
                  svgIconPath="M22,10.1c0.1-0.5-0.3-1.1-0.8-1.1l-5.7-0.8L12.9,3c-0.1-0.2-0.2-0.3-0.4-0.4C12,2.3,11.4,2.5,11.1,3L8.6,8.2L2.9,9C2.6,9,2.4,9.1,2.3,9.3c-0.4,0.4-0.4,1,0,1.4l4.1,4l-1,5.7c0,0.2,0,0.4,0.1,0.6c0.3,0.5,0.9,0.7,1.4,0.4l5.1-2.7l5.1,2.7c0.1,0.1,0.3,0.1,0.5,0.1v0c0.1,0,0.1,0,0.2,0c0.5-0.1,0.9-0.6,0.8-1.2l-1-5.7l4.1-4C21.9,10.5,22,10.3,22,10.1"
                  svgIconViewBox="0 0 24 24"
                />
                {productReviewError && <span className="text-error text-xs italic font-body">{productReviewError}</span>}
              </div>
            </div>

            <div className="input-focus-line">
              <label className="font-body text-[11px] font-semibold text-on-surface-variant uppercase tracking-[0.2em] mb-2 block">
                Your Feedback *
              </label>
              <textarea
                rows={5}
                required
                name="review"
                placeholder="Share your thoughts on our collection and service..."
                className="w-full bg-transparent border-0 border-b border-secondary py-3 px-0 focus:ring-0 text-on-surface transition-ui duration-300 outline-none focus:border-primary font-body resize-none"
                minLength={20}
              />
            </div>

            <div className="input-focus-line">
              <label className="font-body text-[11px] font-semibold text-on-surface-variant uppercase tracking-[0.2em] mb-2 block">
                City / Location *
              </label>
              <input
                type="text"
                required
                name="location"
                placeholder="e.g. Jaipur, Rajasthan"
                className="w-full bg-transparent border-0 border-b border-secondary py-3 px-0 focus:ring-0 text-on-surface transition-ui duration-300 outline-none focus:border-primary font-body"
                minLength={3}
              />
            </div>

            <div className="pt-6">
              <button 
                type="submit" 
                className="px-10 py-4 bg-primary text-white font-body text-xs font-bold uppercase tracking-[0.2em] hover:bg-primary/90 transition-ui duration-300 cursor-pointer"
              >
                Submit Feedback
              </button>
            </div>
          </form>
        </div>
      ) : (
        <div className="bg-sand-light border border-primary/10 p-8 max-w-2xl flex flex-col gap-6 relative overflow-hidden">
          <div className="flex justify-between items-start border-b border-primary/10 pb-6">
            <div>
              <h3 className="font-display text-2xl text-on-surface mb-2">Your Review</h3>
              <StarRatings
                rating={userReview?.rating}
                starDimension="20px"
                starSpacing="2px"
                starRatedColor="#c8a684"
                starEmptyColor="#ebe1d2"
                svgIconPath="M22,10.1c0.1-0.5-0.3-1.1-0.8-1.1l-5.7-0.8L12.9,3c-0.1-0.2-0.2-0.3-0.4-0.4C12,2.3,11.4,2.5,11.1,3L8.6,8.2L2.9,9C2.6,9,2.4,9.1,2.3,9.3c-0.4,0.4-0.4,1,0,1.4l4.1,4l-1,5.7c0,0.2,0,0.4,0.1,0.6c0.3,0.5,0.9,0.7,1.4,0.4l5.1-2.7l5.1,2.7c0.1,0.1,0.3,0.1,0.5,0.1v0c0.1,0,0.1,0,0.2,0c0.5-0.1,0.9-0.6,0.8-1.2l-1-5.7l4.1-4C21.9,10.5,22,10.3,22,10.1"
                svgIconViewBox="0 0 24 24"
              />
            </div>
            <div className="flex gap-4">
              <HashLink 
                to="/#reviews"
                className="text-primary font-body text-xs font-bold uppercase tracking-[0.15em] border-b border-primary pb-0.5 hover:text-primary/70 transition-colors"
              >
                View Publicly
              </HashLink>
              <button 
                onClick={handleDeleteReview}
                className="text-on-surface-variant hover:text-error transition-colors cursor-pointer"
                title="Remove Review"
              >
                <span className="material-symbols-outlined text-[20px]">delete</span>
              </button>
            </div>
          </div>
          
          <div>
            <p className="font-body text-on-surface text-base italic leading-relaxed">
              "{userReview?.review}"
            </p>
            <p className="font-body text-xs text-on-surface-variant uppercase tracking-widest mt-4">
              — {userReview?.name} • {userReview?.location}
            </p>
          </div>
        </div>
      )}
    </div>
  );
};

export default AddReview;
