import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

type NavItem =
  | { kind?: "link"; to: string; label: string; placeholder?: boolean }
  | { kind: "group"; label: string };

const navGroups: NavItem[] = [
  { kind: "group", label: "Platform" },
  { to: "/", label: "Home" },
  { to: "/sites", label: "Sites" },
  { to: "/users", label: "Users" },
  { to: "/monitoring", label: "Monitoring" },
  { to: "/logs", label: "API Logs" },

  { kind: "group", label: "Add-ons" },
  { to: "/addons", label: "Manage Add-ons" },
  { to: "/addons/stats", label: "Stats", placeholder: true },

  { kind: "group", label: "Marketing" },
  { to: "/partners", label: "Partners" },
  { to: "/referrals", label: "Referrals" },
  { to: "/promos", label: "Promos" },

  { kind: "group", label: "Financial" },
  { to: "/subscriptions", label: "Subscription Data", placeholder: true },
  { to: "/infra-costs", label: "Infra Costs", placeholder: true },

  { kind: "group", label: "Config" },
  { to: "/platform-config", label: "Platform Config" },

  { kind: "group", label: "Support" },
  { to: "/support", label: "Tickets" },
  { to: "/media-review", label: "Media Review" },
  { to: "/notifications", label: "Notifications", placeholder: true },
];

export function DashboardLayout() {
  const { user, logout } = useAuth();

  return (
    <div className="dashboard-layout">
      <aside className="sidebar">
        <div className="sidebar-header">
          <h1>Cadmus</h1>
          <span className="sidebar-subtitle">Platform Dashboard</span>
        </div>
        <nav>
          {navGroups.map((item) => {
            if (item.kind === "group") {
              return <div key={item.label} className="nav-group">{item.label}</div>;
            }
            if (item.placeholder) {
              return (
                <span key={item.to} className="nav-link placeholder">{item.label}</span>
              );
            }
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === "/"}
                className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}
              >
                {item.label}
              </NavLink>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <span className="sidebar-user-email">{user?.email}</span>
          <button type="button" className="btn-sidebar-logout" onClick={logout}>
            Log out
          </button>
        </div>
      </aside>
      <main className="main-content">
        <Outlet />
      </main>
    </div>
  );
}
