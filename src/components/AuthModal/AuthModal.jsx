import React, { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import useOtpAuthFlow from "../../hooks/useOtpAuthFlow";
import OtpAuthSteps, { stepHeading } from "../OtpAuthSteps/OtpAuthSteps";
import { useRegisterDialog } from "../../utils/dialogRegistry";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The one sign-in dialog. Mounted once, by LoginGateProvider at the app root;
 * opened through requireLogin() (an intent) or the timed prompt.
 *
 * Accessibility: role="dialog" + aria-modal, labelled by its heading; focus
 * moves into it on open and back to whatever had it on close; Tab and
 * Shift+Tab are trapped inside; Esc closes; the page behind cannot scroll.
 */
const AuthModal = ({ isOpen, message, onDismiss, onComplete }) => {
  const flow = useOtpAuthFlow({ onSignedIn: onComplete });
  const panelRef = useRef(null);
  const returnFocusRef = useRef(null);
  useRegisterDialog("auth-modal", isOpen);

  // A fresh flow every time it opens; remember who had focus.
  useLayoutEffect(() => {
    if (!isOpen) return undefined;
    returnFocusRef.current = document.activeElement;
    flow.reset();
    const { overflow, paddingRight } = document.body.style;
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = "hidden";
    if (scrollbar > 0) document.body.style.paddingRight = `${scrollbar}px`;
    return () => {
      document.body.style.overflow = overflow;
      document.body.style.paddingRight = paddingRight;
      const target = returnFocusRef.current;
      if (target && typeof target.focus === "function" && document.contains(target)) target.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Focus the step's first field whenever the step changes.
  useEffect(() => {
    if (!isOpen || !panelRef.current) return;
    const target =
      panelRef.current.querySelector("[data-autofocus]") || panelRef.current.querySelector(FOCUSABLE);
    target?.focus();
  }, [isOpen, flow.step]);

  if (!isOpen) return null;

  const dismiss = () => {
    if (!flow.busy) onDismiss?.({ signedInMidFlow: flow.step === "details" });
  };

  const onKeyDown = (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      dismiss();
      return;
    }
    if (event.key !== "Tab" || !panelRef.current) return;
    const items = [...panelRef.current.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const heading = stepHeading(flow);

  return createPortal(
    <div
      className="fixed inset-0 z-[10001] flex items-center justify-center bg-inverse-surface/60 backdrop-blur-sm p-4 font-body-base"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) dismiss();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-modal-title"
        aria-describedby="auth-modal-subtitle"
        onKeyDown={onKeyDown}
        className="bg-surface-container rounded-sm shadow-2xl max-w-[420px] w-full max-h-[calc(100dvh-2rem)] overflow-y-auto p-8 md:p-10 relative border border-outline-variant"
      >
        <button
          type="button"
          onClick={dismiss}
          aria-label="Close sign-in"
          className="absolute top-3 right-3 w-11 h-11 flex items-center justify-center text-primary/70 hover:text-primary transition-colors material-symbols-outlined text-[20px]"
        >
          close
        </button>

        <div className="text-center mb-8">
          <img src="/logo.png" alt="Sri Ram Jewellery" className="h-12 w-auto mx-auto object-contain mb-5" />
          <p className="font-label-caps text-[11px] text-primary uppercase tracking-[0.2em] mb-2">{heading.eyebrow}</p>
          <h2 id="auth-modal-title" className="font-display-lg text-headline-sm text-on-surface mb-2">
            {heading.title}
          </h2>
          <p id="auth-modal-subtitle" className="text-on-surface-variant text-sm leading-relaxed">
            {flow.step === "email" && message ? message : heading.subtitle}
          </p>
        </div>

        <OtpAuthSteps key={flow.step === "email" ? "email" : flow.email} flow={flow} idPrefix="auth-modal" />
      </div>
    </div>,
    document.body
  );
};

export default AuthModal;
