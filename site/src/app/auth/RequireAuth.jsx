import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "./AuthProvider.jsx";
import { areaOf, homeFor, loginPath } from "./roles.js";
import { BootScreen, NoAccess, Unavailable } from "../shell/ShellStates.jsx";

// area: "client" requires the client role, "admin" any staff role; the wrong
// area sends people to their own home. cap (string or any-of array) renders a
// polite no-access state in place, inside the shell.
export default function RequireAuth({ area, cap, children }) {
  const { user, loading, error, refresh, can } = useAuth();
  const location = useLocation();
  if (loading) return <BootScreen />;
  if (!user) {
    if (error) return <Unavailable error={error} onRetry={refresh} />;
    return <Navigate to={loginPath(location)} replace />;
  }
  if (area && areaOf(user) !== area) return <Navigate to={homeFor(user)} replace />;
  if (area === "client" && !can("portal.access")) return <NoAccess standalone />;
  if (cap && !can(cap)) return <NoAccess />;
  return children ?? <Outlet />;
}
