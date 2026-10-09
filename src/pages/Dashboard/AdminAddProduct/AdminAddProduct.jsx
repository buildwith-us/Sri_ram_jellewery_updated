import React, { useEffect, useState } from "react";
import "./AdminAddProduct.css";
import { useForm, Controller } from "react-hook-form";
import PriceBreakdownPreview from "../../../components/PriceBreakdownPreview/PriceBreakdownPreview";
import useRates from "../../../hooks/useRates";
import { Link, useLocation, useParams } from "react-router-dom";
import uploadIcon from "../../../assets/image-upload.png";
import axios from "axios";
import { getApiBaseUrl } from "../../../utils/apiConfig";
import useAuthContext from "../../../hooks/useAuthContext";
import Select from "react-select";
import Swal from "sweetalert2";
import useProducts from "../../../hooks/useProducts";
import useAxiosSecure from "../../../hooks/useAxiosSecure";
import useCategories from "../../../hooks/useCategories";
import { optimizeCloudinaryUrl } from "../../../utils/cloudinaryImage";

const AdminAddProduct = () => {
  const { user } = useAuthContext();
  const [axiosSecure] = useAxiosSecure();
  const [productError, setProductError] = useState(null);
  const { categories } = useCategories();

  const [defaultBadges, setDefaultBadges] = useState([]);

  // find product to edit the product
  const location = useLocation();
  const { id: paramId } = useParams();
  const productId = paramId || location.state?.id;
  const [dynamicProduct, setDynamicProduct] = useState(null);
  const [products] = useProducts();

  useEffect(() => {
    if (products && productId) {
      const product = products.find((p) => p._id === productId);
      setDynamicProduct(product);
    }
  }, [productId, products]);

  // react hook form settings
  const {
    register,
    handleSubmit,
    control,
    reset,
    watch,
    formState: { errors },
  } = useForm();

  const isQuoteOnlyValue = watch("isQuoteOnly", false);
  // Watched so the price preview recalculates as the owner types.
  const weightValue = watch("weight");
  const wastageValue = watch("wastagePercent");
  const gstValue = watch("gstPercent");
  const metalTypeValue = watch("metalType");
  const discountValue = watch("discountPercentage");
  const { rates } = useRates();

  // default tag options for badges list
  const [tagOptions] = useState([
    { value: "hot", label: "Hot Deal" },
    { value: "flashSale", label: "Flash Sale" },
    { value: "newArrival", label: "New Arrival" },
  ]);

  // SET PRODUCT BADGE DEFAULT VALUES
  useEffect(() => {
    if (dynamicProduct) {
      setDefaultBadges([
        dynamicProduct?.newArrival ? tagOptions[2] : null,
        dynamicProduct?.badge === "HOT" ? tagOptions[0] : null,

        dynamicProduct?.flashSale ? tagOptions[1] : null,
      ]);
    }
  }, [tagOptions, dynamicProduct]);

  // set default values for the form when edit the product
  useEffect(() => {
    if (dynamicProduct) {
      let defaultValues = {};

      defaultValues.name = dynamicProduct.name || "";
      defaultValues.description = dynamicProduct.details?.description || "";
      defaultValues.advantages = dynamicProduct.details?.advantages?.join(", ") || "";
      // The STORED making charge, not the computed customer price the list
      // shows — editing used to save the customer price over the making charge.
      defaultValues.price = dynamicProduct.storedPrice ?? "";
      defaultValues.discountPercentage = dynamicProduct.discountPercentage ?? "";
      defaultValues.weight = dynamicProduct.weight || "";
      defaultValues.wastagePercent = dynamicProduct.wastagePercent || "";
      defaultValues.gstPercent = dynamicProduct.gstPercent || "";
      defaultValues.metalType = dynamicProduct.metalType || "gold";
      defaultValues.isQuoteOnly = dynamicProduct.isQuoteOnly || false;
      defaultValues.category = dynamicProduct.category || "";
      defaultValues.selectedBadges = defaultBadges;
      defaultValues.stock = dynamicProduct.stock?.toString() || "";
      defaultValues.size = dynamicProduct.size || "";
      defaultValues.carate = dynamicProduct.carate?.toString() || "";

      reset({ ...defaultValues });
    }
  }, [reset, dynamicProduct, defaultBadges]);

  // Uploads directly to Cloudinary using a short-lived signature minted by our
  // server, so the API secret never reaches the browser.
  const uploadProductImage = async (file) => {
    const { data: sig } = await axiosSecure.get("/admin/cloudinary-signature");

    const formData = new FormData();
    formData.append("file", file);
    formData.append("api_key", sig.apiKey);
    formData.append("timestamp", sig.timestamp);
    formData.append("signature", sig.signature);

    const { data: uploaded } = await axios.post(
      `https://api.cloudinary.com/v1_1/${sig.cloudName}/image/upload`,
      formData
    );
    return uploaded.secure_url;
  };

  const onSubmit = async (data) => {
    try {
      const badges = data?.selectedBadges?.map((b) => b?.value);
    const product = {
      name: data.name,
      category: data.category,
      details: {
        description: data.description,
        advantages: data.advantages ? data.advantages.split(",").map((a) => a.trim()).filter(Boolean) : [],
      },
      // Blank stays blank (null), never 0: a weightless piece saved at ₹0
      // would have sold for nothing.
      price: data.price === "" || data.price == null ? null : parseFloat(data.price),
      weight: parseFloat(data.weight) || 0,
      wastagePercent: parseFloat(data.wastagePercent) || 0,
      gstPercent: parseFloat(data.gstPercent) || 0,
      metalType: data.metalType || "gold",
      isQuoteOnly: data.isQuoteOnly || false,
      // A plain percentage of the whole piece, applied before GST by
      // computePrice. The discounted price is calculated, never stored.
      discountPercentage:
        data.discountPercentage === "" || data.discountPercentage == null ? null : parseFloat(data.discountPercentage),
      size: data.size || "",
      stock: parseInt(data.stock) || 0,
      carate: data.carate ? parseInt(data.carate) : null,
      newArrival: badges?.indexOf("newArrival") !== -1 ? true : false,
      // The badge is a label, not a flag: "HOT" or none (null). Sending false
      // used to be stored as the text "false" (S9b).
      badge: badges?.includes("hot") ? "HOT" : null,
      flashSale: badges?.indexOf("flashSale") !== -1 ? true : false,
      addedAt: new Date(),
    };

    const imgFile = data.productImg?.[0];
    if (imgFile?.size > 2097152) {
      Swal.fire({
        title: "Image Size Exceeded!",
        text: "Your product image size is more than 2MB.",
        icon: "error",
      });
      return;
    }

    const { isConfirmed } = await Swal.fire({
      title: "Are you sure?",
      text: "Did you make sure all data provided are correct?",
      icon: "question",
      showCancelButton: true,
      confirmButtonColor: "#000",
      cancelButtonColor: "#ef4c53",
      confirmButtonText: "Yes, Publish it!",
    });
    if (!isConfirmed) return;

    if (imgFile) {
      try {
        product.img = await uploadProductImage(imgFile);
      } catch (uploadError) {
        console.error(uploadError);
        Swal.fire("Upload Failed", "Could not upload image to Cloudinary", "error");
        return;
      }
    } else {
      product.img = dynamicProduct.img;
    }

    const res = dynamicProduct
      ? await axiosSecure.patch(`/products/${dynamicProduct._id}`, product)
      : await axiosSecure.post("/products", product);

    if (res.data.success) {
      Swal.fire({
        title: "Success!",
        text: `Product has been ${dynamicProduct ? "updated" : "added"} successfully`,
        icon: "success",
      });
    }
    } catch (err) {
      console.error("Submit Error: ", err);
      Swal.fire("Submit Error", "An error occurred during submission: " + err.message, "error");
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-6 md:p-margin-desktop bg-background custom-scrollbar w-full">
      <div>
        <nav aria-label="Breadcrumb" className="text-sm">
          <ol className="flex items-center gap-2 text-on-surface-variant">
            <li>
              <Link
                className="inline-flex items-center min-h-11 hover:text-primary transition-colors"
                to={"/dashboard/adminDashboard"}
              >
                Dashboard
              </Link>
            </li>
            <li aria-hidden="true" className="text-outline-variant">
              /
            </li>
            <li>
              <Link
                className="inline-flex items-center min-h-11 hover:text-primary transition-colors"
                to="/dashboard/adminAddProducts"
              >
                {productId ? "Edit Product" : "Add Products"}
              </Link>
            </li>
          </ol>
        </nav>

        <h2
          className="mt-1 font-bold text-3xl"
          style={{ fontFamily: "var(--italiana)" }}
        >
          {productId ? "Edit Product" : "Add New Products"}
        </h2>
      </div>

      <div>
        {/* Debug: Show all form errors to catch hidden validation issues */}
        {Object.keys(errors).length > 0 && (
          <div className="bg-error-container text-on-error-container mb-8 rounded-lg p-4 text-sm">
            <span className="font-bold">Form Validation Errors:</span>
            <pre className="text-xs text-left overflow-auto mt-2 p-2 bg-black/20 rounded">
              {JSON.stringify(
                Object.keys(errors).reduce((acc, key) => {
                  acc[key] = errors[key]?.message || errors[key]?.type || "error";
                  return acc;
                }, {}),
                null,
                2
              )}
            </pre>
          </div>
        )}

        {/* error notification */}
        {productError && (
          <div
            role="alert"
            className="bg-error-container text-on-error-container mb-8 rounded-lg p-4 text-sm font-semibold flex items-center gap-3"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="stroke-current shrink-0 h-6 w-6 cursor-pointer"
              fill="none"
              viewBox="0 0 24 24"
              onClick={() => setProductError(null)}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <span>Error: {productError}</span>
          </div>
        )}

        <div>
          <form
            onSubmit={handleSubmit(onSubmit)}
            className="loginRegisterForm my-10 flex flex-col md:flex-row md:items-start md:justify-between gap-8 relative"
          >
            <div className="md:w-[65%]">
              <div className="bg-surface-container-low/50 border border-sand/30 p-6 md:p-8 hover:bg-white transition-ui rounded-xl">
                <h4 className="font-display-md text-headline-sm text-primary border-b border-sand/30 pb-4 mb-8">
                  Basic Information
                </h4>

                {/* Product name input */}
                <div className="w-full auth-input-con px-6">
                  <p className="text-outline font-label-caps tracking-[0.1em] text-xs uppercase">Product Name *</p>
                  <input
                    type="text"
                    {...register("name", { required: true })}
                    className="w-full bg-transparent border-0 border-b border-outline-variant py-3 px-0 focus:ring-0 text-on-surface placeholder:text-on-surface-variant/30 transition-ui duration-300 outline-none focus:border-primary"
                  />
                  {errors.name && (
                    <span className="text-error mt-1 block">
                      Product name is required
                    </span>
                  )}
                </div>

                {/* description input */}
                <div className="w-full mt-8 auth-input-con px-6">
                  <p className="text-outline font-label-caps tracking-[0.1em] text-xs uppercase">Description *</p>
                  <textarea
                    name="description"
                    rows="8"
                    className="w-full bg-transparent border-0 border-b border-outline-variant py-3 px-0 focus:ring-0 text-on-surface placeholder:text-on-surface-variant/30 transition-ui duration-300 outline-none focus:border-primary resize-none"
                    {...register("description")}
                  ></textarea>
                </div>

                {/* advantages input */}
                <div className="w-full mt-8 auth-input-con px-6">
                  <p className="text-outline font-label-caps tracking-[0.1em] text-xs uppercase">Advantages *</p>
                  <textarea
                    name="advantages"
                    rows="4"
                    className="w-full bg-transparent border-0 border-b border-outline-variant py-3 px-0 focus:ring-0 text-on-surface placeholder:text-on-surface-variant/30 transition-ui duration-300 outline-none focus:border-primary resize-none"
                    {...register("advantages")}
                    placeholder="Separate each advantage with comma(,)"
                  ></textarea>
                </div>
              </div>

              <div className="mt-10 shadow rounded-lg border pb-8">
                <h4 className="font-display-md text-headline-sm text-primary border-b border-sand/30 pb-4 mb-8">
                  Pricing & Specs
                </h4>

                {/* isQuoteOnly Checkbox */}
                <div className="w-full auth-input-con px-6 mb-6">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      {...register("isQuoteOnly")}
                      className="w-5 h-5 shrink-0 rounded-sm border border-outline-variant accent-primary cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary/40"
                    />
                    <span className="text-outline font-label-caps tracking-[0.1em] text-xs uppercase font-bold">Price on Request (Quote Only)</span>
                  </label>
                  <p className="text-xs text-on-surface-variant mt-1">If checked, weight and calculated price will be hidden from customers.</p>
                </div>

                {!isQuoteOnlyValue && (
                  <>
                    <div className="w-full auth-input-con px-6">
                      <p className="text-outline font-label-caps tracking-[0.1em] text-xs uppercase">Metal *</p>
                      <select
                        {...register("metalType", { required: !isQuoteOnlyValue })}
                        className="w-full bg-transparent border-0 border-b border-outline-variant py-3 px-0 focus:ring-0 text-on-surface transition-ui duration-300 outline-none focus:border-primary"
                      >
                        <option value="gold">Gold</option>
                        <option value="silver">Silver</option>
                      </select>
                      <p className="text-xs text-on-surface-variant mt-1">
                        Decides which live rate prices this piece.
                      </p>
                      {errors.metalType && (
                        <span className="text-error mt-1 block">Metal is required</span>
                      )}
                    </div>

                    <div className="w-full auth-input-con px-6 mt-8">
                      <p className="text-outline font-label-caps tracking-[0.1em] text-xs uppercase">Weight (grams) *</p>
                      <input
                        type="number"
                        step="0.01"
                        {...register("weight", { required: !isQuoteOnlyValue })}
                        className="w-full bg-transparent border-0 border-b border-outline-variant py-3 px-0 focus:ring-0 text-on-surface placeholder:text-on-surface-variant/30 transition-ui duration-300 outline-none focus:border-primary"
                      />
                      {errors.weight && (
                        <span className="text-error mt-1 block">Weight is required</span>
                      )}
                    </div>
                    
                    <div className="w-full auth-input-con px-6 mt-8">
                      <p className="text-outline font-label-caps tracking-[0.1em] text-xs uppercase">Wastage % *</p>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        max="100"
                        {...register("wastagePercent", { required: !isQuoteOnlyValue, min: 0, max: 100 })}
                        className="w-full bg-transparent border-0 border-b border-outline-variant py-3 px-0 focus:ring-0 text-on-surface placeholder:text-on-surface-variant/30 transition-ui duration-300 outline-none focus:border-primary"
                      />
                      {errors.wastagePercent && (
                        <span className="text-error mt-1 block">Valid wastage % is required (0-100)</span>
                      )}
                    </div>

                    <div className="w-full auth-input-con px-6 mt-8">
                      <p className="text-outline font-label-caps tracking-[0.1em] text-xs uppercase">GST % *</p>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        max="100"
                        {...register("gstPercent", { required: !isQuoteOnlyValue, min: 0, max: 100 })}
                        className="w-full bg-transparent border-0 border-b border-outline-variant py-3 px-0 focus:ring-0 text-on-surface placeholder:text-on-surface-variant/30 transition-ui duration-300 outline-none focus:border-primary"
                      />
                      {errors.gstPercent && (
                        <span className="text-error mt-1 block">Valid GST % is required (0-100)</span>
                      )}
                    </div>

                    <PriceBreakdownPreview
                      weight={weightValue}
                      wastagePercent={wastageValue}
                      gstPercent={gstValue}
                      metalType={metalTypeValue}
                      discountPercentage={discountValue}
                      rates={rates}
                    />

                    {/* Product price input */}
                    <div className="w-full auth-input-con px-6 mt-8">
                      <p className="text-outline font-label-caps tracking-[0.1em] text-xs uppercase">Making Charges / Fixed Price (if any)</p>
                      <input
                        type="number"
                        step="0.01"
                        {...register("price")}
                        className="w-full bg-transparent border-0 border-b border-outline-variant py-3 px-0 focus:ring-0 text-on-surface placeholder:text-on-surface-variant/30 transition-ui duration-300 outline-none focus:border-primary"
                      />
                    </div>

                    {/* Discount % — of the whole piece, before GST */}
                    <div className="mt-8 px-6">
                      <div className="auth-input-con">
                        <label htmlFor="discountPercentage" className="text-outline font-label-caps tracking-[0.1em] text-xs uppercase">
                          Discount %
                        </label>
                        <input
                          id="discountPercentage"
                          type="number"
                          step="0.01"
                          min="0"
                          max="100"
                          {...register("discountPercentage", { min: 0, max: 100 })}
                          className="w-full bg-transparent border-0 border-b border-outline-variant py-3 px-0 focus:ring-0 text-on-surface placeholder:text-on-surface-variant/30 transition-ui duration-300 outline-none focus:border-primary"
                          placeholder="e.g. 10 — leave blank for none"
                        />
                        {errors.discountPercentage && (
                          <span className="text-error mt-1 block">Discount must be between 0 and 100</span>
                        )}
                        <p className="text-[11px] text-on-surface-variant mt-1">
                          Taken off the whole piece before GST. The preview above shows what the customer pays.
                        </p>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="md:w-[35%]">
              <div className="bg-surface-container-low/50 border border-sand/30 p-6 md:p-8 hover:bg-white transition-ui rounded-xl">
                <h4 className="font-display-md text-headline-sm text-primary border-b border-sand/30 pb-4 mb-8">
                  Upload Image
                </h4>
                <div>
                  {dynamicProduct?.img ? (
                    <figure>
                      <img
                        src={optimizeCloudinaryUrl(dynamicProduct?.img, { width: 300 })}
                        alt=""
                        className="block mx-auto mb-2 w-[50%] bg-surface-container p-3 rounded-lg"
                      />
                      <figcaption className="text-center text-sm">
                        Current Image
                      </figcaption>
                    </figure>
                  ) : (
                    <>
                      <img
                        src={uploadIcon}
                        alt=""
                        className="block mx-auto mb-1"
                      />
                      <p className="text-center text-xs font-light">
                        Image size must not be more than 2Mb
                      </p>
                    </>
                  )}

                  <input
                    type="file"
                    className="w-full max-w-xs mt-4 mx-auto block text-sm text-on-surface-variant file:mr-4 file:py-2.5 file:px-4 file:rounded-sm file:border-0 file:font-label-caps file:text-[11px] file:uppercase file:tracking-[0.1em] file:bg-surface-container file:text-on-surface hover:file:bg-primary hover:file:text-white file:cursor-pointer file:transition-colors"
                    accept=".jpg, .jpeg, .png"
                    name="productImg"
                    {...register("productImg", {
                      required: !dynamicProduct && true,
                    })}
                  />

                  {errors.productImg && (
                    <span className="text-error mt-1 text-center block">
                      Product image is required
                    </span>
                  )}
                </div>
              </div>

              <div className="bg-surface-container-low/50 border border-sand/30 p-6 md:p-8 hover:bg-white transition-ui rounded-xl mt-8">
                <h4 className="font-display-md text-headline-sm text-primary border-b border-sand/30 pb-4 mb-8">
                  Product Details
                </h4>

                <div className="w-full px-6">
                  <p className="text-outline font-label-caps tracking-[0.1em] text-xs uppercase mb-4">Category *</p>
                  <Controller
                    name="category"
                    control={control}
                    defaultValue=""
                    rules={{ required: "Please select an option" }}
                    render={({ field, fieldState }) => (
                      <>
                        <select
                          {...field}
                          className="w-full bg-transparent border-0 border-b border-outline-variant py-3 px-0 focus:ring-0 text-on-surface transition-ui duration-300 outline-none focus:border-primary"
                        >
                          <option value="" disabled>
                            Select an option
                          </option>
                          {categories?.map((c) => (
                            <option value={c.categoryName} key={c._id}>
                              {c.categoryName}
                            </option>
                          ))}
                        </select>
                        {fieldState.error && (
                          <p className="text-error">
                            {fieldState.error.message}
                          </p>
                        )}
                      </>
                    )}
                  />
                </div>

                <div className="w-full auth-input-con px-6 mt-6 badge-container">
                  <p className="text-outline font-label-caps tracking-[0.1em] text-xs uppercase mb-4">Badges</p>
                  <Controller
                    name="selectedBadges"
                    control={control}
                    defaultValue={[]}
                    render={({ field }) => (
                      <Select
                        {...field}
                        isMulti
                        options={tagOptions}
                        placeholder="Select badges..."
                      />
                    )}
                  />
                </div>
              </div>

              <div className="bg-surface-container-low/50 border border-sand/30 p-6 md:p-8 hover:bg-white transition-ui rounded-xl mt-8">
                <h4 className="font-display-md text-headline-sm text-primary border-b border-sand/30 pb-4 mb-8">
                  Product Attributes
                </h4>

                <div className="w-full auth-input-con px-6">
                  <p className="text-outline font-label-caps tracking-[0.1em] text-xs uppercase">Stock Quantity *</p>
                  <input
                    type="number"
                    {...register("stock", { required: true })}
                    className="w-full bg-transparent border-0 border-b border-outline-variant py-3 px-0 focus:ring-0 text-on-surface placeholder:text-on-surface-variant/30 transition-ui duration-300 outline-none focus:border-primary"
                  />
                  {errors.stock && (
                    <span className="text-error mt-1 block">
                      Product stock is required
                    </span>
                  )}
                </div>

                <div className="w-full px-6 mt-6">
                  <p className="text-outline font-label-caps tracking-[0.1em] text-xs uppercase mb-4">Size *</p>
                  <Controller
                    name="size"
                    control={control}
                    defaultValue=""
                    rules={{ required: false }}
                    render={({ field, fieldState }) => (
                      <>
                        <select
                          {...field}
                          className="w-full bg-transparent border-0 border-b border-outline-variant py-3 px-0 focus:ring-0 text-on-surface transition-ui duration-300 outline-none focus:border-primary"
                        >
                          <option value="">
                            Select the size (Optional)
                          </option>
                          <option value="Large">Large</option>
                          <option value="Medium">Medium</option>
                          <option value="Small">Small</option>
                          <option value="Extra Small">Extra Small</option>
                          <option value="Extra Large">Extra Large</option>
                        </select>
                        {fieldState.error && (
                          <p className="text-error">
                            {fieldState.error.message}
                          </p>
                        )}
                      </>
                    )}
                  />
                </div>

                <div className="w-full px-6 mt-6">
                  <p className="text-outline font-label-caps tracking-[0.1em] text-xs uppercase mb-4">Carate *</p>
                  <Controller
                    name="carate"
                    control={control}
                    defaultValue=""
                    rules={{ required: false }}
                    render={({ field, fieldState }) => (
                      <>
                        <select
                          {...field}
                          className="w-full bg-transparent border-0 border-b border-outline-variant py-3 px-0 focus:ring-0 text-on-surface transition-ui duration-300 outline-none focus:border-primary"
                        >
                          <option value="">
                            Select the carate (Optional)
                          </option>
                          <option value="8">8K</option>
                          <option value="10">10K</option>
                          <option value="14">14K</option>
                          <option value="18">18K</option>
                          <option value="22">22K</option>
                        </select>
                        {fieldState.error && (
                          <p className="text-error">
                            {fieldState.error.message}
                          </p>
                        )}
                      </>
                    )}
                  />
                </div>
              </div>
            </div>

            {dynamicProduct ? (
              <button
                type="submit"
                className="md:absolute md:-top-20 md:right-0 bg-primary text-white py-4 md:py-5 px-8 font-button-text uppercase tracking-[0.2em] text-[12px] hover:bg-primary-container transition-ui duration-500 transform hover:scale-[1.01] active:scale-[0.98] w-full md:w-auto"
              >
                Publish Edit
              </button>
            ) : (
              <button
                type="submit"
                className="absolute -top-20 right-0 bg-primary text-white py-4 md:py-5 px-8 font-button-text uppercase tracking-[0.2em] text-[12px] hover:bg-primary-container transition-ui duration-500 transform hover:scale-[1.01] active:scale-[0.98] w-full md:w-auto"
              >
                Publish
              </button>
            )}
          </form>
        </div>
      </div>
    </div>
  );
};

export default AdminAddProduct;
