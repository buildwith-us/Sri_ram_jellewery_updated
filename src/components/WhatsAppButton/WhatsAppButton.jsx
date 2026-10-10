import React from "react";
import { useLocation } from "react-router-dom";
import { whatsAppLink } from "../../utils/whatsapp";
import { useAnyDialogOpen } from "../../utils/dialogRegistry";

// The owner's screens, and the admin sign-in: not for customers.
const HIDDEN_PATHS = /^\/(dashboard\/admin|admin-login)/;

/** WhatsApp's mark, decorative: the visible text carries the meaning. */
export const WhatsAppIcon = ({ className = "w-5 h-5" }) => (
  <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true" focusable="false">
    <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38a9.9 9.9 0 0 0 4.74 1.21h.01c5.46 0 9.9-4.45 9.9-9.91A9.85 9.85 0 0 0 12.04 2Zm5.8 14.06c-.24.69-1.42 1.32-1.96 1.37-.5.05-.98.24-3.3-.69-2.8-1.1-4.58-3.97-4.72-4.15-.14-.18-1.12-1.5-1.12-2.86 0-1.36.71-2.03.97-2.31.25-.28.55-.35.74-.35l.53.01c.17 0 .4-.06.62.48.24.56.8 1.94.87 2.08.07.14.12.3.02.48-.09.18-.14.3-.28.46l-.42.49c-.14.14-.28.29-.12.57.16.28.72 1.19 1.55 1.93 1.06.95 1.96 1.24 2.24 1.38.28.14.44.12.6-.07.17-.19.7-.81.88-1.09.19-.28.37-.23.62-.14.26.09 1.62.77 1.9.91.28.14.46.21.53.32.07.12.07.67-.17 1.36Z" />
  </svg>
);

/**
 * "Chat on WhatsApp", floating bottom right on every customer page. A link
 * (it navigates to WhatsApp), with visible text — never an icon alone.
 *
 * Steps aside whenever something is open over the page — the cart drawer,
 * the sign-in modal, the quote and zoom dialogs, the phone menu — so it never
 * sits on top of them. Not rendered when VITE_WHATSAPP_NUMBER is unset.
 */
const WhatsAppButton = () => {
  const { pathname } = useLocation();
  const dialogOpen = useAnyDialogOpen();
  const href = whatsAppLink();

  if (!href || dialogOpen || HIDDEN_PATHS.test(pathname)) return null;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Chat with Sri Ram Jewellery on WhatsApp (opens WhatsApp)"
      data-testid="whatsapp-chat"
      className="fixed z-40 right-4 md:right-6 inline-flex items-center gap-2 min-h-12 pl-3 pr-4 rounded-full bg-[#1f7a4d] text-white font-button-text text-[13px] tracking-wide shadow-lg hover:bg-[#17633e] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary transition-colors"
      style={{ bottom: "calc(1rem + env(safe-area-inset-bottom, 0px))" }}
    >
      <WhatsAppIcon className="w-6 h-6" />
      <span className="md:hidden">WhatsApp</span>
      <span className="hidden md:inline">Chat on WhatsApp</span>
    </a>
  );
};

export default WhatsAppButton;
