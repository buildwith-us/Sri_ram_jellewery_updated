import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { useQueryClient } from "react-query";
import useAuthContext from "./useAuthContext";
import { getApiBaseUrl } from "../utils/apiConfig";
import { getErrorMessage } from "../utils/errorMessage";
import { normalizeIndianPhone } from "../../shared/phone.js";

/** Seconds before "Resend code" is offered again after a code is sent. */
export const RESEND_COOLDOWN_SECONDS = 30;

/** The same rules the server applies; it checks again regardless. */
const checkDetails = ({ name, phone }) => {
  const cleanName = String(name || "").trim();
  if (!cleanName) return { ok: false, reason: "Please enter your name" };
  if (cleanName.length > 100) return { ok: false, reason: "Name must be under 100 characters" };
  const normalized = normalizeIndianPhone(phone);
  if (!normalized.ok) return { ok: false, reason: normalized.reason };
  return { ok: true, details: { name: cleanName, phone: normalized.phone } };
};

/**
 * The customer sign-in flow, shared by the sign-in modal and the /login and
 * /register pages so there is exactly one implementation. Two paths:
 *
 *   "signin"  email → code. An address with no account then asks for name
 *             and phone (stage "newAccount"), holding the verified code, and
 *             the account is created with them.
 *   "create"  name + phone (stage "signup", checked here only) → email →
 *             code, the held details sent with the code.
 *
 * Nothing is saved before the code is verified: the name and phone stay in
 * this hook until then, and the server creates the account only with them
 * (POST /auth/otp/verify). Whether a phone is already registered is learnt
 * only after the code — before it, saying so would tell a stranger.
 *
 * Stage "profile" is an EXISTING account with gaps (created before name and
 * phone were required). It is already signed in, so closing it signs out
 * (see LoginGateContext), and it saves through PATCH /users/me — the only
 * write that changes a profile.
 *
 * `onSignedIn({ isNewAccount, user })` fires once, when the customer is signed
 * in with a complete profile.
 */
const useOtpAuthFlow = ({ onSignedIn, initialMode = "signin" } = {}) => {
  const { requestOtp, verifyOtp, refreshAccessToken, getAccessToken } = useAuthContext();
  const queryClient = useQueryClient();

  const [mode, setMode] = useState(initialMode);
  const [step, setStep] = useState(initialMode === "create" ? "details" : "email");
  const [stage, setStage] = useState("signup"); // which details step: signup | newAccount | profile
  const [email, setEmail] = useState("");
  const [details, setDetails] = useState(null); // held, unsaved { name, phone }
  const [heldCode, setHeldCode] = useState(null); // a verified code awaiting details
  const [missing, setMissing] = useState([]);
  // What the details form starts with: the held details, or the account's.
  const [prefill, setPrefill] = useState({ name: "", phone: "" });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [resendIn, setResendIn] = useState(0);

  // One tick a second while a countdown is running.
  useEffect(() => {
    if (resendIn <= 0) return undefined;
    const t = setTimeout(() => setResendIn((s) => Math.max(0, s - 1)), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  const startMode = useCallback((next) => {
    setMode(next);
    setStep(next === "create" ? "details" : "email");
    setStage("signup");
    setDetails(null);
    setHeldCode(null);
    setMissing([]);
    setPrefill({ name: "", phone: "" });
    setError(null);
    setBusy(false);
  }, []);

  const reset = useCallback(() => {
    startMode(initialMode);
    setEmail("");
    setResendIn(0);
  }, [initialMode, startMode]);

  /** Switch between "Sign in" and "Create account", keeping the email. */
  const switchMode = (next) => startMode(next);

  /** Open straight at "details" for a signed-in customer with gaps. */
  const startDetails = useCallback(({ email: address = "", missing: gaps, name = "", phone = "" } = {}) => {
    setEmail(address);
    setStage("profile");
    setMissing(gaps?.length ? gaps : ["name", "phone"]);
    setPrefill({ name: name || "", phone: phone || "" });
    setError(null);
    setBusy(false);
    setStep("details");
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
      setHeldCode(null);
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

  /** Back to a details step, keeping what was typed and the verified code. */
  const backToDetails = (nextStage, held, message) => {
    setStage(nextStage);
    setPrefill({ name: held?.name || "", phone: held?.phone || "" });
    setError(message);
    setStep("details");
  };

  /** Save name + phone on a signed-in account — PATCH /users/me, the one write. */
  const completeProfile = async (held) => {
    await axios.patch(`${getApiBaseUrl()}/users/me`, held, {
      headers: { Authorization: `Bearer ${getAccessToken()}` },
    });
    // Re-issue the session so the token (and the header) carry the name.
    await refreshAccessToken();
    // The profile everything else reads (useUserInfo) must say "complete"
    // before the flow ends, or the gate would ask again straight away.
    await queryClient.refetchQueries(["user"]);
  };

  /**
   * POST the code, with the held details when there are any, and act on the
   * answer. A refused code stays on the code step; refused details go back to
   * the details step with the code still held.
   */
  const verify = async (otp, held) => {
    let result;
    try {
      result = await verifyOtp(email, String(otp || "").trim(), held || undefined);
    } catch (err) {
      if (held && (err?.status === 400 || err?.status === 409)) {
        setHeldCode(otp);
        backToDetails(stage === "newAccount" ? "newAccount" : "signup", held, getErrorMessage(err));
        return;
      }
      if (step === "details") setStep("code"); // the held code expired meanwhile
      showRefusal(err, "That code didn't work. Check it and try again.");
      return;
    }

    if (result.needsDetails) {
      // The code is right and this address has no account: name and phone
      // first, then the same code creates it.
      setHeldCode(otp);
      backToDetails("newAccount", null, null);
      return;
    }

    if (result.profileComplete === false) {
      // An existing account with gaps. Fill them with what was just typed if
      // there is anything; otherwise ask, already signed in.
      if (held) {
        try {
          await completeProfile(held);
          onSignedIn?.({ isNewAccount: false, user: result.user });
          return;
        } catch (err) {
          setStage("profile");
          setMissing(result.missing || ["name", "phone"]);
          backToDetails("profile", held, err?.response?.data?.error || "We couldn't save your details.");
          return;
        }
      }
      setMissing(result.missing || ["name", "phone"]);
      backToDetails("profile", { name: result.user?.name, phone: result.user?.phone }, null);
      return;
    }

    onSignedIn?.({ isNewAccount: Boolean(result.isNewAccount), user: result.user });
  };

  const submitCode = async (otp) => {
    setError(null);
    setBusy(true);
    try {
      await verify(otp, mode === "create" ? details : null);
    } finally {
      setBusy(false);
    }
  };

  const submitDetails = async (typed) => {
    setError(null);

    if (stage === "profile") {
      setBusy(true);
      try {
        await completeProfile({ name: String(typed.name || "").trim(), phone: String(typed.phone || "").trim() });
        onSignedIn?.({ isNewAccount: false });
      } catch (err) {
        // e.g. 409 — the number already belongs to another account.
        setError(err?.response?.data?.error || "We couldn't save your details. Please try again.");
      } finally {
        setBusy(false);
      }
      return;
    }

    const checked = checkDetails(typed);
    if (!checked.ok) {
      setError(checked.reason);
      return;
    }
    setDetails(checked.details);

    // Before the email (Create account): hold them and ask for the email.
    if (!heldCode) {
      setStep("email");
      return;
    }
    // After a verified code: create the account with them.
    setBusy(true);
    try {
      await verify(heldCode, checked.details);
    } finally {
      setBusy(false);
    }
  };

  const changeEmail = () => {
    setStep("email");
    setHeldCode(null);
    setError(null);
  };

  return {
    mode,
    step,
    stage,
    email,
    missing,
    prefill,
    error,
    busy,
    resendIn,
    // Only an existing account's details step is signed in; closing it signs out.
    signedInMidFlow: step === "details" && stage === "profile",
    reset,
    switchMode,
    submitEmail,
    submitCode,
    resend,
    submitDetails,
    changeEmail,
    startDetails,
  };
};

export default useOtpAuthFlow;
