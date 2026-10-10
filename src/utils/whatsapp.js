/**
 * The shop's WhatsApp, for customers. Both values are build-time env vars
 * (Vite inlines VITE_*), so changing the number means a redeploy:
 *
 *   VITE_WHATSAPP_NUMBER    international, digits only (a leading + is ignored)
 *   VITE_WHATSAPP_GREETING  the message a plain chat opens with
 *
 * Separate from the server's ADMIN_WHATSAPP_NUMBER, which is where the owner's
 * automatic alerts are sent and may be a different phone.
 *
 * Nothing here may carry a price or a customer's details: a wa.me message is
 * text in a URL, kept in browser history and in WhatsApp itself.
 */

const DEFAULT_GREETING = "Hi, I'd like to know more about your jewellery.";

/** The number as wa.me wants it (digits only), or null when not configured. */
export const shopWhatsAppNumber = () => {
  const digits = String(import.meta.env.VITE_WHATSAPP_NUMBER || "").replace(/\D/g, "");
  return digits.length >= 10 ? digits : null;
};

export const whatsAppGreeting = () => String(import.meta.env.VITE_WHATSAPP_GREETING || "").trim() || DEFAULT_GREETING;

/** https://wa.me/<number>?text=<message>, or null when no number is set. */
export const whatsAppLink = (text = whatsAppGreeting()) => {
  const number = shopWhatsAppNumber();
  if (!number) return null;
  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
};
