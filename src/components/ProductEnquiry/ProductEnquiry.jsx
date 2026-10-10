import React, { useEffect, useRef, useState } from "react";
import useAuthContext from "../../hooks/useAuthContext";
import useUserInfo from "../../hooks/useUserInfo";
import useAxiosSecure from "../../hooks/useAxiosSecure";
import { useLoginGate } from "../../context/LoginGateContext";
import { useRegisterDialog } from "../../utils/dialogRegistry";
import { enquiryMessage, shopWhatsAppNumber, whatsAppLink } from "../../utils/whatsapp";
import { normalizeIndianPhone, CANONICAL_PHONE } from "../../../shared/phone.js";
import { WhatsAppIcon } from "../WhatsAppButton/WhatsAppButton";

const inputClass =
  "w-full bg-surface-container-low border border-outline-variant/50 px-4 py-3 text-sm focus:border-primary focus:ring-1 focus:ring-primary outline-none transition-ui rounded-sm";
const labelClass = "block font-label-caps text-xs text-on-surface-variant uppercase tracking-wider mb-2";

const formatPhone = (phone) => {
  const national = String(phone || "").replace(/^\+91/, "");
  return /^\d{10}$/.test(national) ? `+91 ${national.slice(0, 5)} ${national.slice(5)}` : phone;
};

/**
 * Enquiring about a piece — priced or quote-only — two ways, one record:
 *
 *   Ask on WhatsApp  saves the enquiry (POST /api/quotes, channel "whatsapp")
 *                    with the name and phone on the account, then opens the
 *                    shop's chat with the piece, its link and the SRQ-…
 *                    reference prefilled.
 *   Enquire now      the form (channel "form"), the fallback for anyone who
 *                    would rather not use WhatsApp.
 *
 * The enquiry is always saved first, so it is never lost. Browsers block a
 * window opened after a network call, so the WhatsApp window is opened on the
 * tap itself and pointed at the chat once the enquiry is saved; if it was
 * blocked, the confirmation says the enquiry is saved and offers the chat as a
 * link to tap.
 */
const ProductEnquiry = ({ product }) => {
  const { user } = useAuthContext();
  const [profile] = useUserInfo();
  const [axiosSecure] = useAxiosSecure();
  const { requireLogin } = useLoginGate();
  const hasWhatsApp = Boolean(shopWhatsAppNumber());

  // null (closed) | "form" | "sending" | "done" | "failed"
  const [view, setView] = useState(null);
  const [name, setName] = useState("");
  const [mobile, setMobile] = useState("");
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null); // { quote, link, channel, opened }
  const panelRef = useRef(null);
  useRegisterDialog("quote-modal", view !== null);

  // Focus into the dialog when it opens or changes view.
  useEffect(() => {
    if (!view || !panelRef.current) return;
    (panelRef.current.querySelector("[data-autofocus]") || panelRef.current.querySelector("button, a, input"))?.focus();
  }, [view]);

  const close = () => {
    if (view === "sending") return;
    setView(null);
    setError(null);
  };

  const productUrl = `${window.location.origin}/products/${product._id}/description`;
  const chatLinkFor = (quote) =>
    whatsAppLink(enquiryMessage({ productName: quote.productName, productUrl, quoteId: quote.quoteId }));

  const save = (customerName, customerMobile, channel) =>
    axiosSecure
      .post("/quotes", { productId: product.productId || product._id, customerName, customerMobile, channel })
      .then((res) => res.data.data);

  const openForm = () => {
    if (!user) {
      requireLogin({
        message: "Sign in to send an enquiry about this piece.",
        intent: { type: "enquire", productId: product.productId || product._id },
      });
      return;
    }
    setName(profile?.name || "");
    setMobile(profile?.phone || "");
    setError(null);
    setView("form");
  };

  const askOnWhatsApp = async () => {
    if (!user) {
      requireLogin({
        message: "Sign in to ask about this piece on WhatsApp.",
        intent: { type: "enquire", productId: product.productId || product._id },
      });
      return;
    }
    // The enquiry needs a name and a mobile; without them, the form asks.
    if (!profile?.name || !CANONICAL_PHONE.test(String(profile?.phone || ""))) {
      openForm();
      return;
    }

    // Opened now, during the tap — after the save it would be blocked.
    let win = null;
    try {
      win = window.open("", "_blank");
      if (win) {
        win.opener = null;
        win.document.title = "Opening WhatsApp…";
        win.document.body.innerHTML = '<p style="font-family:sans-serif;padding:24px">Opening WhatsApp…</p>';
      }
    } catch {
      win = null;
    }

    setError(null);
    setView("sending");
    try {
      const quote = await save(profile.name, profile.phone, "whatsapp");
      const link = chatLinkFor(quote);
      let opened = false;
      if (win && !win.closed) {
        try {
          win.location.href = link;
          opened = true;
        } catch {
          opened = false;
        }
      }
      setResult({ quote, link, channel: "whatsapp", opened });
      setView("done");
    } catch (err) {
      try {
        win?.close();
      } catch {
        /* already gone */
      }
      setError(err?.response?.data?.error || "We couldn't send your enquiry. Please try again.");
      setView("failed");
    }
  };

  const submitForm = async (e) => {
    e.preventDefault();
    const cleanName = name.trim();
    if (!cleanName) return setError("Please enter your name");
    const phone = normalizeIndianPhone(mobile);
    if (!phone.ok) return setError(phone.reason);

    setError(null);
    setView("sending");
    try {
      const quote = await save(cleanName, phone.phone, "form");
      setResult({ quote, link: hasWhatsApp ? chatLinkFor(quote) : null, channel: "form", opened: false });
      setView("done");
    } catch (err) {
      setError(err?.response?.data?.error || "We couldn't send your enquiry. Please try again.");
      setView("form");
    }
  };

  const onKeyDown = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };

  return (
    <>
      {hasWhatsApp && (
        <button
          type="button"
          onClick={askOnWhatsApp}
          // Signed in but the profile (name, phone) not loaded yet: a moment.
          disabled={Boolean(user) && !profile}
          className="w-full disabled:opacity-60 bg-[#1f7a4d] text-white py-5 font-button-text text-button-text tracking-widest hover:bg-[#17633e] active:scale-[0.98] transition-ui flex items-center justify-center gap-3 rounded-sm"
        >
          <WhatsAppIcon className="w-5 h-5" />
          ASK ON WHATSAPP
        </button>
      )}
      <button
        type="button"
        onClick={openForm}
        className="w-full bg-transparent border border-sand text-primary py-5 font-button-text text-button-text tracking-widest hover:bg-primary/5 active:scale-[0.98] transition-ui flex items-center justify-center gap-3 rounded-sm"
      >
        <span className="material-symbols-outlined text-sm" aria-hidden="true">mail</span>
        ENQUIRE NOW
      </button>

      {view && (
        <dialog className="modal modal-open" aria-labelledby="enquiry-title" onKeyDown={onKeyDown}>
          <div ref={panelRef} role="document" className="modal-box bg-surface border border-outline-variant/30 rounded-sm">
            <button
              type="button"
              aria-label="Close quote request"
              onClick={close}
              disabled={view === "sending"}
              className="inline-flex items-center justify-center w-11 h-11 rounded-full text-on-surface hover:bg-surface-container transition-colors absolute right-2 top-2"
            >
              ✕
            </button>

            {view === "form" && (
              <>
                <h3 id="enquiry-title" className="font-display-lg text-headline-sm text-primary mb-2">
                  Enquire about this piece
                </h3>
                <p className="font-body-base text-on-surface-variant text-sm mb-6">{product.name}</p>
                {error && (
                  <p role="alert" className="mb-4 p-3 bg-error-container text-on-error-container text-sm font-semibold rounded-sm">
                    {error}
                  </p>
                )}
                <form onSubmit={submitForm} className="space-y-4" noValidate>
                  <div>
                    <label className={labelClass} htmlFor="enquiry-name">Name</label>
                    <input
                      id="enquiry-name"
                      type="text"
                      autoComplete="name"
                      maxLength={100}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className={inputClass}
                      placeholder="Your full name"
                      data-autofocus
                    />
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="enquiry-mobile">Mobile number</label>
                    <input
                      id="enquiry-mobile"
                      type="tel"
                      inputMode="tel"
                      autoComplete="tel"
                      maxLength={20}
                      value={mobile}
                      onChange={(e) => setMobile(e.target.value)}
                      className={inputClass}
                      placeholder="98765 43210"
                    />
                  </div>
                  <button
                    type="submit"
                    className="w-full mt-4 bg-primary text-white py-4 font-button-text uppercase tracking-widest hover:bg-primary-container transition-colors rounded-sm"
                  >
                    Send enquiry
                  </button>
                </form>
              </>
            )}

            {view === "sending" && (
              <p id="enquiry-title" className="py-8 text-center text-on-surface-variant" aria-live="polite">
                Sending your enquiry…
              </p>
            )}

            {view === "failed" && (
              <>
                <h3 id="enquiry-title" className="font-display-lg text-headline-sm text-primary mb-4">
                  Not sent
                </h3>
                <p role="alert" className="mb-6 p-3 bg-error-container text-on-error-container text-sm font-semibold rounded-sm">
                  {error}
                </p>
                <div className="flex flex-col gap-3">
                  <button
                    type="button"
                    onClick={askOnWhatsApp}
                    data-autofocus
                    className="w-full bg-primary text-white py-4 font-button-text uppercase tracking-widest rounded-sm"
                  >
                    Try again
                  </button>
                  <button type="button" onClick={openForm} className="w-full py-3 text-primary font-button-text underline">
                    Use the enquiry form instead
                  </button>
                </div>
              </>
            )}

            {view === "done" && result && (
              <div data-testid="enquiry-done">
                <h3 id="enquiry-title" className="font-display-lg text-headline-sm text-primary mb-4">
                  Enquiry sent
                </h3>
                <p className="font-body-base text-on-surface text-sm mb-2">
                  Your enquiry about <strong>{result.quote.productName}</strong> has been sent to the shop.
                </p>
                <p className="font-body-base text-on-surface text-sm mb-6">
                  Reference: <strong data-testid="enquiry-ref">{result.quote.quoteId}</strong>
                </p>

                {result.channel === "whatsapp" ? (
                  <p className="text-sm text-on-surface-variant mb-6">
                    {result.opened
                      ? "WhatsApp is opening with your reference in the message. If it didn't open, use the button below."
                      : "Your browser didn't let WhatsApp open, but your enquiry is saved. Tap below to open the chat."}
                  </p>
                ) : (
                  <p className="text-sm text-on-surface-variant mb-6">
                    It includes the number you gave, {formatPhone(result.quote.customerMobile)}.
                    {result.link ? " Prefer to chat? You can also continue on WhatsApp." : ""}
                  </p>
                )}

                <div className="flex flex-col gap-3">
                  {result.link && (
                    <a
                      href={result.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-autofocus
                      className="w-full bg-[#1f7a4d] text-white py-4 font-button-text uppercase tracking-widest rounded-sm inline-flex items-center justify-center gap-2 hover:bg-[#17633e]"
                    >
                      <WhatsAppIcon className="w-5 h-5" />
                      {result.channel === "whatsapp" ? "Open WhatsApp" : "Continue on WhatsApp"}
                    </a>
                  )}
                  <button type="button" onClick={close} className="w-full py-3 text-primary font-button-text underline">
                    Done
                  </button>
                </div>
              </div>
            )}
          </div>
          <div className="modal-backdrop" onClick={close} aria-hidden="true" />
        </dialog>
      )}
    </>
  );
};

export default ProductEnquiry;
