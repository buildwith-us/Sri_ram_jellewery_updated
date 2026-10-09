import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import AuthModal from "../components/AuthModal/AuthModal";
import useAuthContext from "../hooks/useAuthContext";
import useUserInfo from "../hooks/useUserInfo";
import { isAnyDialogOpen } from "../utils/dialogRegistry";

const LoginGateContext = createContext(null);

const PENDING_KEY = "sri-ram-pending-action";

/** Active time on the site before the sign-in prompt appears once. */
export const AUTH_PROMPT_DELAY_MS = 30000;
/** How long a dismissal keeps the timed prompt away. */
export const AUTH_PROMPT_DISMISS_DAYS = 7;

const DISMISSED_UNTIL_KEY = "sri-ram-auth-prompt-dismissed-until"; // localStorage
const SHOWN_THIS_SESSION_KEY = "sri-ram-auth-prompt-shown"; // sessionStorage

// Never prompt here: the purchase itself (checkout and the payment step), the
// admin dashboard, and the pages that are already about signing in.
const NO_PROMPT_PATHS = [
  /^\/checkout/,
  /^\/payment/,
  /^\/dashboard\/admin/,
  /^\/login/,
  /^\/register/,
  /^\/admin-login/,
  /^\/forgot-password/,
  /^\/reset-password/,
];

// Storage can throw (Safari private mode, blocked site data). Every access is
// best-effort; failing to remember a dismissal must never break the page.
const safe = (fn, fallback) => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

/** Persist the action the user was attempting so it can resume after login. */
export const readPendingAction = () =>
  safe(() => {
    const raw = sessionStorage.getItem(PENDING_KEY);
    return raw ? JSON.parse(raw) : null;
  }, null);

export const clearPendingAction = () => safe(() => sessionStorage.removeItem(PENDING_KEY));

const savePendingAction = (intent) => safe(() => sessionStorage.setItem(PENDING_KEY, JSON.stringify(intent)));

const dismissedRecently = () =>
  safe(() => Number(localStorage.getItem(DISMISSED_UNTIL_KEY) || 0) > Date.now(), false);

const rememberDismissal = () =>
  safe(() =>
    localStorage.setItem(DISMISSED_UNTIL_KEY, String(Date.now() + AUTH_PROMPT_DISMISS_DAYS * 24 * 60 * 60 * 1000))
  );

const shownThisSession = () => safe(() => sessionStorage.getItem(SHOWN_THIS_SESSION_KEY) === "1", false);
const markShownThisSession = () => safe(() => sessionStorage.setItem(SHOWN_THIS_SESSION_KEY, "1"));

const isPromptPath = (pathname) => !NO_PROMPT_PATHS.some((re) => re.test(pathname));

// The sign-in pages run the details step themselves, in the page.
const AUTH_PAGE_PATHS = /^\/(login|register)(\/|$)/;

/**
 * The sign-in gate. Mounted ONCE, at the app root (layouts/AppShell), so the
 * modal, its timer and the pending action survive moving between the main
 * site, a product page and the dashboard.
 *
 * Two ways in:
 *   - requireLogin({ message, intent }) — Add to Bag, Buy Now, wishlist, the
 *     drawer's Checkout. Opens immediately, timer and dismissal regardless;
 *     the intent is replayed after sign-in by useResumePendingAction.
 *   - the timed prompt — once per session, after AUTH_PROMPT_DELAY_MS of
 *     active (visible-tab) time, never on NO_PROMPT_PATHS, never over another
 *     dialog, and not again for 7 days once dismissed.
 *
 * And one rule: a signed-in customer always has a name and a phone. The
 * session is issued with the code, before the details step, so leaving that
 * step (closing the modal, or walking off /login) used to leave a customer
 * signed in without them, and a restored session never asked again. Now the
 * profile is checked whenever a customer is signed in — on sign-in, reload or
 * session restore — and if it is incomplete the details step opens, on any
 * page but the sign-in pages (which show it themselves). Closing it signs out.
 */
export const LoginGateProvider = ({ children }) => {
  const { user, isAuthLoading, logOut } = useAuthContext();
  const [profile] = useUserInfo();
  const location = useLocation();
  const navigate = useNavigate();
  const [modal, setModal] = useState({ open: false, message: "", profilePrompt: null });
  const signingOutRef = useRef(false);

  // Customers only: an administrator's account has no delivery details.
  const profileIncomplete = Boolean(user && profile?.role === "USER" && profile.profileComplete === false);
  // Signed in, profile not loaded yet — don't resume anything until it is.
  const profilePending = Boolean(user && !profile);

  const pathRef = useRef(location.pathname);
  pathRef.current = location.pathname;
  const fromRef = useRef(`${location.pathname}${location.search}`);
  fromRef.current = `${location.pathname}${location.search}`;
  const userRef = useRef(user);
  userRef.current = user;

  const requireLogin = useCallback(({ message, intent } = {}) => {
    if (userRef.current) return;
    if (intent) savePendingAction(intent);
    setModal({ open: true, message: message || "", profilePrompt: null });
  }, []);

  // ── Timed prompt: count only time the tab is visible ────────────────────
  useEffect(() => {
    if (isAuthLoading || user || shownThisSession() || dismissedRecently()) return undefined;

    let activeMs = 0;
    let last = performance.now();
    let done = false;

    const accrue = () => {
      const now = performance.now();
      if (document.visibilityState === "visible") activeMs += now - last;
      last = now;
    };

    const onVisibility = () => {
      // Leaving: bank the visible time so far. Returning: restart the clock
      // now, so the hidden stretch is never counted.
      if (document.visibilityState === "hidden") accrue();
      else last = performance.now();
    };

    const tick = setInterval(() => {
      if (done) return;
      accrue();
      if (activeMs < AUTH_PROMPT_DELAY_MS) return;
      // Due — but wait for a moment when it is allowed to appear.
      if (userRef.current || !isPromptPath(pathRef.current) || isAnyDialogOpen() || dismissedRecently()) return;
      done = true;
      markShownThisSession();
      setModal({ open: true, message: "", profilePrompt: null });
    }, 1000);

    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [user, isAuthLoading]);

  // ── Incomplete profile: back to the details step ──────────────────────
  useEffect(() => {
    if (!profileIncomplete || modal.open || signingOutRef.current) return;
    if (AUTH_PAGE_PATHS.test(location.pathname)) return;
    setModal({
      open: true,
      message: "",
      profilePrompt: {
        email: profile.email || "",
        missing: profile.missing,
        name: profile.name || "",
        phone: profile.phone || "",
      },
    });
  }, [profileIncomplete, modal.open, location.pathname, profile]);

  useEffect(() => {
    if (!user) signingOutRef.current = false;
  }, [user]);

  const handleDismiss = useCallback(
    ({ signedInMidFlow } = {}) => {
      setModal({ open: false, message: "", profilePrompt: null });
      // Declining to sign in also declines the action that asked for it.
      if (!signedInMidFlow) {
        clearPendingAction();
        rememberDismissal();
        return;
      }
      // Closed at the details step: no session without a name and a phone.
      signingOutRef.current = true;
      clearPendingAction();
      logOut().then(() =>
        toast("You're signed out. We need your name and mobile number to finish setting up your account.")
      );
    },
    [logOut]
  );

  const handleComplete = useCallback(
    ({ isNewAccount } = {}) => {
      const wasProfilePrompt = Boolean(modal.profilePrompt);
      setModal({ open: false, message: "", profilePrompt: null });
      if (readPendingAction()) return; // useResumePendingAction finishes what they started
      if (wasProfilePrompt) {
        toast.success("Thank you — your details are saved.");
        return;
      }
      if (isNewAccount) {
        navigate("/welcome", { state: { from: fromRef.current } });
      } else {
        toast.success("You're signed in");
      }
    },
    [navigate, modal.profilePrompt]
  );

  return (
    <LoginGateContext.Provider value={{ requireLogin, isAuthFlowOpen: modal.open || profileIncomplete || profilePending }}>
      {children}
      <AuthModal
        isOpen={modal.open}
        message={modal.message}
        profilePrompt={modal.profilePrompt}
        onDismiss={handleDismiss}
        onComplete={handleComplete}
      />
    </LoginGateContext.Provider>
  );
};

export const useLoginGate = () => {
  const ctx = useContext(LoginGateContext);
  return ctx || { requireLogin: () => {}, isAuthFlowOpen: false };
};

export default LoginGateContext;
