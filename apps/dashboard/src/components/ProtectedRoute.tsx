import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

export function ProtectedRoute() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="auth-page">
        <p>Loading...</p>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (user.globalRole !== "cadmus_admin") {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h2>Access Denied</h2>
          <p>This dashboard is restricted to platform administrators.</p>
        </div>
      </div>
    );
  }

  return <Outlet />;
}
