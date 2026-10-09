/**
 * Canonical phone handling. The server's answer, not the client's.
 *
 * Normalisation used to live only in `usePhoneAuthFlow.jsx`, which meant the
 * canonical form of a customer's identity was decided in the browser. Anything
 * that reached the API by another path — curl, a second client, an older cached
 * bundle, a direct POST — was written to the database verbatim. That is how
 * "9363750806" and "+919363750806" became two accounts for one person, each
 * with its own cart, wishlist and order history.
 *
 * The phone number is the primary key of a customer's identity here (there is
 * no password and often no email), so its canonical form has to be decided in
 * exactly one place, and that place must be the server.
 *
 * Canonical form: +91XXXXXXXXXX
 */

export { CANONICAL_PHONE, normalizeIndianPhone } from "../../shared/phone.js";
import { normalizeIndianPhone } from "../../shared/phone.js";

/**
 * Every stored spelling that could refer to the same real number.
 *
 * Used by the duplicate-account tooling to find records written before
 * normalisation moved server-side. Not used on the sign-in path — that resolves
 * to exactly one canonical value.
 */
export const phoneVariants = (canonical) => {
  const national = canonical.replace(/^\+91/, "");
  return [
    canonical,          // +919363750806
    national,           // 9363750806
    `91${national}`,    // 919363750806
    `0${national}`,     // 09363750806
    `+91 ${national}`,  // spaced, as some clients sent it
  ];
};

export default normalizeIndianPhone;
