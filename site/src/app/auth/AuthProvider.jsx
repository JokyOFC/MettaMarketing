import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client.js";

const AuthContext = createContext(null);
const signedOut = { user: null, loading: false, error: null, expired: false };

// The session lives in an httpOnly cookie; the frontend only mirrors /auth/me.
// Nothing here grants access by itself: every endpoint re-checks on the server.
export function AuthProvider({ children }) {
  const navigate = useNavigate();
  const [state, setState] = useState({ ...signedOut, loading: true });

  const refresh = useCallback(async () => {
    try {
      const data = await api.get("/auth/me");
      const user = data?.user ?? null;
      setState((current) => ({ ...current, user, loading: false, error: null }));
      return user;
    } catch (error) {
      if (error.status === 401) {
        setState((current) => ({ ...current, user: null, loading: false, error: null }));
        return null;
      }
      // Network or server trouble: keep whatever we knew and let the UI offer a retry.
      setState((current) => ({ ...current, loading: false, error }));
      return null;
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // A 401 from any request means the session is gone: drop the user and let
  // RequireAuth send them to /login?next=…; the login page explains why.
  useEffect(() => {
    const onLost = (event) => {
      const path = event.detail?.path || "";
      if (/auth\/(me|login)$/.test(path)) return;
      setState((current) =>
        current.user ? { ...signedOut, expired: true } : current,
      );
    };
    window.addEventListener("metta:unauthenticated", onLost);
    return () => window.removeEventListener("metta:unauthenticated", onLost);
  }, []);

  const login = useCallback(async (email, password) => {
    const data = await api.post("/auth/login", { email, password });
    setState({ ...signedOut, user: data.user });
    return data.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post("/auth/logout");
    } catch {
      /* the cookie may already be gone; leaving is what matters */
    }
    setState(signedOut);
    navigate("/login", { replace: true });
  }, [navigate]);

  const setUser = useCallback((user) => setState({ ...signedOut, user }), []);

  const value = useMemo(() => {
    const caps = new Set(state.user?.capabilities || []);
    return {
      user: state.user,
      loading: state.loading,
      error: state.error,
      expired: state.expired,
      can: (cap) => {
        if (!cap) return true;
        return Array.isArray(cap) ? cap.some((c) => caps.has(c)) : caps.has(cap);
      },
      login,
      logout,
      refresh,
      setUser,
    };
  }, [state, login, logout, refresh, setUser]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside <AuthProvider>.");
  return value;
}
