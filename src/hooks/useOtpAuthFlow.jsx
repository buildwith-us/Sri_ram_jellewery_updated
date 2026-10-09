import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import useAuthContext from "./useAuthContext";
import { getApiBaseUrl } from "../utils/apiConfig";
import { getErrorMessage } from "../utils/errorMessage";

/** Seconds before "Resend code" is offered again after a code is sent. */
export const RESEND_COOLDOWN_SECONDS = 30;

/**
 * The customer sign-in flow, shared by the sign-in modal and the /login and
 * /register pages so there is exactly one implementation:
 *
 *   "email"   → the customer types their email; a 6-digit code is emailed
 *   "code"    → they type the code (resend after a 30 s countdown)
 *   "details" → only when the server says the profile is incomplete:
 *               name and phone, saved through PATCH /users/me
 *
 * Every request goes through AuthProvider (requestOtp / verifyOtp) — this hook
 * holds only UI state. `onSignedIn({ isNewAccount })` fires once at the end:
 * after the code for a returning customer, after the details for a new one.
 */
const useOtpAuthFlow = ({ onSignedIn } = {}) => {
  const { requestOtp, verifyOtp, refreshAccessToken, getAccessToken } = useAuthContext();

  const [step, setStep] = useState("email");
  const [email, setEmail] = useState("");
  const [missing, setMissing] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [resendIn, setResendIn] = useState(0);

  // One tick a second while a countdown is running.
  useEffect(() => {
    if (resendIn <= 0) return undefined;
    const t = setTimeout(() => setResendIn((s) => Math.max(0, s - 1)), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  const reset = useCallback(() => {
    setStep("email");
    setEmail("");
    setMissing([]);
    setError(null);
    setBusy(false);
    setResendIn(0);
  }, []);

  // Show the server's own words when it refuses, and when it is a rate limit
  // honour its Retry-After rather than letting the button invite a retry that
  // will be refused again.
  const showRefusal = (err, fallback) => {
    setError(getErrorMessage(err, fallback));
    if (err?.status === 429) setResendIn((s) => Math.max(s, err.retryAfter || RESEND_COOLDOWN_SECONDS));
  };

  const send = async (address) => {
    await requestOtp(address);
    setResendIn(RESEND_COOLDOWN_SECONDS);
  };

  const submitEmail = async (value) => {
    const address = String(value || "").trim();
    setError(null);
    setBusy(true);
    try {
      await send(address);
      setEmail(address);
      setStep("code");
    } catch (err) {
      showRefusal(err, "We couldn't send a code. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    if (resendIn > 0 || busy) return false;
    setError(null);
    setBusy(true);
    try {
      await send(email);
      return true;
    } catch (err) {
      showRefusal(err, "We couldn't send a new code. Please try again.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (otp) => {
    setError(null);
    setBusy(true);
    try {
      const result = await verifyOtp(email, String(otp || "").trim());
      if (result.profileComplete === false) {
        setMissing(result.missing || ["name", "phone"]);
        setStep("details");
      } else {
        onSignedIn?.({ isNewAccount: false, user: result.user });
      }
    } catch (err) {
      showRefusal(err, "That code didn't work. Check it and try again.");
    } finally {
      setBusy(false);
    }
  };

  const submitDetails = async ({ name, phone }) => {
    setError(null);
    setBusy(true);
    try {
      await axios.patch(
        `${getApiBaseUrl()}/users/me`,
        { name: String(name || "").trim(), phone: String(phone || "").trim() },
        { headers: { Authorization: `Bearer ${getAccessToken()}` } }
      );
      // Re-issue the session so the token (and the header) carry the name.
      await refreshAccessToken();
      onSignedIn?.({ isNewAccount: true });
    } catch (err) {
      // e.g. 409 — the number already belongs to another account.
      setError(err?.response?.data?.error || "We couldn't save your details. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const changeEmail = () => {
    setStep("email");
    setError(null);
  };

  return {
    step,
    email,
    missing,
    error,
    busy,
    resendIn,
    reset,
    submitEmail,
    submitCode,
    resend,
    submitDetails,
    changeEmail,
  };
};

export default useOtpAuthFlow;
