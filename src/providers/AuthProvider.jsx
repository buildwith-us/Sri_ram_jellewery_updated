import React, { useEffect, useState, useCallback } from "react";
import { createContext } from "react";
import axios from "axios";
import { getApiBaseUrl } from "../utils/apiConfig";

export const AuthContext = createContext(null);

const TOKEN_KEY = "sri-ram-access-token";
const REFRESH_KEY = "sri-ram-refresh-token";

const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);

  // True when this visitor arrived holding credentials that turned out to be
  // dead: the app booted with a stored token, could not refresh it, and signed
  // them out. Distinct from simply not being signed in, and that difference is
  // what the sign-in page needs in order to explain itself.
  //
  // The axios interceptor handles the other half — a token dying mid-session on
  // a page that is already open. That path never runs on a cold start, because
  // PrivateRoute redirects before any request is issued. Relying on the
  // interceptor alone left the commonest case (returning the next day) bouncing
  // to /login with no explanation at all.
  const [sessionExpired, setSessionExpired] = useState(false);

  const apiBase = getApiBaseUrl();

  // ─── Token helpers ─────────────────────────────────────────────────────────
  const storeTokens = (accessToken, refreshToken) => {
    localStorage.setItem(TOKEN_KEY, accessToken);
    localStorage.setItem(REFRESH_KEY, refreshToken);
  };

  const clearTokens = () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
  };

  const getAccessToken = () => localStorage.getItem(TOKEN_KEY);
  const getRefreshToken = () => localStorage.getItem(REFRESH_KEY);

  /**
   * Decode JWT payload (without verification — just to read expiry/user data).
   */
  const decodeToken = (token) => {
    try {
      const payload = token.split(".")[1];
      return JSON.parse(atob(payload));
    } catch {
      return null;
    }
  };

  /**
   * Check if a JWT is expired (with 30s buffer for clock skew).
   */
  const isTokenExpired = (token) => {
    const decoded = decodeToken(token);
    if (!decoded || !decoded.exp) return true;
    return decoded.exp * 1000 < Date.now() + 30000; // 30s buffer
  };

  // ─── Auth actions ──────────────────────────────────────────────────────────

  /**
   * Sign Up — POST /api/auth/register
   */
  const signUp = async (name, email, password) => {
    setIsAuthLoading(true);
    try {
      const res = await axios.post(`${apiBase}/auth/register`, { name, email, password });
      const { accessToken, refreshToken, user: userData } = res.data;
      storeTokens(accessToken, refreshToken);
      setUser(userData);
      setIsAuthLoading(false);
      return res.data;
    } catch (error) {
      setIsAuthLoading(false);
      throw error.response?.data || error;
    }
  };

  /**
   * Sign In — POST /api/auth/login
   */
  const signIn = async (email, password) => {
    setIsAuthLoading(true);
    try {
      const res = await axios.post(`${apiBase}/auth/login`, { email, password });
      const { accessToken, refreshToken, user: userData } = res.data;
      storeTokens(accessToken, refreshToken);
      setUser(userData);
      setIsAuthLoading(false);
      return res.data;
    } catch (error) {
      setIsAuthLoading(false);
      throw error.response?.data || error;
    }
  };

  /**
   * Request a sign-in code — POST /api/auth/otp/request. Customers sign in
   * with their email address; the code is emailed to them.
   *
   * A refusal keeps its HTTP status and, when rate-limited, the server's
   * Retry-After (seconds), so the resend countdown can respect it.
   */
  const requestOtp = async (email) => {
    try {
      const res = await axios.post(`${apiBase}/auth/otp/request`, { email });
      return res.data;
    } catch (error) {
      const body = error.response?.data;
      const retryAfter = Number(error.response?.headers?.["retry-after"]);
      throw {
        ...(body && typeof body === "object" ? body : { error: error.message }),
        status: error.response?.status,
        retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
      };
    }
  };

  /**
   * Verify a sign-in code — POST /api/auth/otp/verify. The response says
   * whether the profile is complete (profileComplete / missing), so callers
   * never have to infer it from the user record.
   */
  const verifyOtp = async (email, otp) => {
    setIsAuthLoading(true);
    try {
      const res = await axios.post(`${apiBase}/auth/otp/verify`, { email, otp });
      const { accessToken, refreshToken, user: userData } = res.data;
      storeTokens(accessToken, refreshToken);
      setUser(userData);
      setIsAuthLoading(false);
      return res.data;
    } catch (error) {
      setIsAuthLoading(false);
      throw error.response?.data || error;
    }
  };

  /**
   * Refresh the access token using the stored refresh token.
   * Returns the new access token, or null on failure.
   */
  const refreshAccessToken = useCallback(async () => {
    const refreshToken = getRefreshToken();
    if (!refreshToken) return null;

    try {
      const res = await axios.post(`${apiBase}/auth/refresh`, { refreshToken });
      const { accessToken: newAccess, refreshToken: newRefresh, user: userData } = res.data;
      storeTokens(newAccess, newRefresh);
      setUser(userData);
      return newAccess;
    } catch {
      // Refresh failed — session expired
      clearTokens();
      setUser(null);
      return null;
    }
  }, [apiBase]);

  /**
   * Log Out — POST /api/auth/logout
   */
  const logOut = async () => {
    try {
      const token = getAccessToken();
      if (token) {
        await axios.post(`${apiBase}/auth/logout`, {}, {
          headers: { Authorization: `Bearer ${token}` },
        });
      }
    } catch {
      // Silent fail — we're clearing tokens regardless
    } finally {
      clearTokens();
      setUser(null);
      setIsAuthLoading(false);
    }
  };

  // ─── Session bootstrap (on app load) ───────────────────────────────────────
  useEffect(() => {
    const bootstrapAuth = async () => {
      const accessToken = getAccessToken();

      if (!accessToken) {
        setUser(null);
        setIsAuthLoading(false);
        return;
      }

      // If token is still valid, decode user from it
      if (!isTokenExpired(accessToken)) {
        const decoded = decodeToken(accessToken);
        if (decoded) {
          setUser({
            _id: decoded.userId,
            email: decoded.email,
            role: decoded.role,
            name: decoded.name,
          });

          // Also fetch full user profile from backend
          try {
            const res = await axios.get(`${apiBase}/users/me`, {
              headers: { Authorization: `Bearer ${accessToken}` },
            });
            if (res.data?.success && res.data?.data) {
              setUser(res.data.data);
            }
          } catch {
            // Token might have been invalidated server-side
            const newToken = await refreshAccessToken();
            if (!newToken) {
              clearTokens();
              setUser(null);
              setSessionExpired(true);
            }
          }
        }
        setIsAuthLoading(false);
        return;
      }

      // Token expired — try refresh
      const newToken = await refreshAccessToken();
      if (!newToken) {
        clearTokens();
        setUser(null);
        // They had a session and it is gone. PrivateRoute reads this to send
        // them somewhere that says so.
        setSessionExpired(true);
      }
      setIsAuthLoading(false);
    };

    bootstrapAuth();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const value = {
    user,
    isAuthLoading,
    sessionExpired,
    signUp,
    signIn,
    logOut,
    refreshAccessToken,
    requestOtp,
    verifyOtp,
    setIsAuthLoading,
    getAccessToken,
    getRefreshToken,
  };

  return (
    <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
  );
};

export default AuthProvider;
