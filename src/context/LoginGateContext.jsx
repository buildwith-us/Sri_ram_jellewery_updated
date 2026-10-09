import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import AuthModal from "../components/AuthModal/AuthModal";
import useAuthContext from "../hooks/useAuthContext";
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
 */
export const LoginGateProvider = ({ children }) => {
  const { user, isAuthLoading } = useAuthContext();
  const location = useLocation();
  const navigate = useNavigate();
  const [modal, setModal] = useState({ open: false, message: "" });

  const pathRef = useRef(location.pathname);
  pathRef.current = location.pathname;
  const fromRef = useRef(`${location.pathname}${location.search}`);
  fromRef.current = `${location.pathname}${location.search}`;
  const userRef = useRef(user);
  userRef.current = user;

  const requireLogin = useCallback(({ message, intent } = {}) => {
    if (userRef.current) return;
    if (intent) savePendingAction(intent);
    setModal({ open: true, message: message || "" });
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
      setModal({ open: true, message: "" });
    }, 1000);

    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [user, isAuthLoading]);

  const handleDismiss = useCallback(({ signedInMidFlow } = {}) => {
    setModal({ open: false, message: "" });
    // Declining to sign in also declines the action that asked for it.
    if (!signedInMidFlow) {
      clearPendingAction();
      rememberDismissal();
    }
  }, []);

  const handleComplete = useCallback(
    ({ isNewAccount } = {}) => {
      setModal({ open: false, message: "" });
      if (readPendingAction()) return; // useResumePendingAction finishes what they started
      if (isNewAccount) {
        navigate("/welcome", { state: { from: fromRef.current } });
      } else {
        toast.success("You're signed in");
      }
    },
    [navigate]
  );

  return (
    <LoginGateContext.Provider value={{ requireLogin, isAuthFlowOpen: modal.open }}>
      {children}
      <AuthModal isOpen={modal.open} message={modal.message} onDismiss={handleDismiss} onComplete={handleComplete} />
    </LoginGateContext.Provider>
  );
};

export const useLoginGate = () => {
  const ctx = useContext(LoginGateContext);
  return ctx || { requireLogin: () => {}, isAuthFlowOpen: false };
};

export default LoginGateContext;
