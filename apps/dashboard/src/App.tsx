import { createBrowserRouter, RouterProvider, Outlet } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext";
import { DashboardLayout } from "./layouts/DashboardLayout";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { Login } from "./pages/Login";
import { Home } from "./pages/Home";
import { SitesList } from "./pages/SitesList";
import { SiteDetail } from "./pages/SiteDetail";
import { Partners } from "./pages/Partners";
import { PartnerDetail } from "./pages/PartnerDetail";
import { Referrals } from "./pages/Referrals";
import { Users } from "./pages/Users";
import { Monitoring } from "./pages/Monitoring";
import { Logs } from "./pages/Logs";
import { Support } from "./pages/Support";
import { MediaReview } from "./pages/MediaReview";
import { PlatformConfig } from "./pages/PlatformConfig";
import { Promos } from "./pages/Promos";
import { Addons } from "./pages/Addons";

function AuthRoot() {
  return (
    <AuthProvider>
      <Outlet />
    </AuthProvider>
  );
}

const router = createBrowserRouter([
  {
    element: <AuthRoot />,
    children: [
      { path: "/login", element: <Login /> },
      {
        element: <ProtectedRoute />,
        children: [
          {
            element: <DashboardLayout />,
            children: [
              { path: "/", element: <Home /> },
              { path: "/sites", element: <SitesList /> },
              { path: "/sites/:id", element: <SiteDetail /> },
              { path: "/partners", element: <Partners /> },
              { path: "/partners/:id", element: <PartnerDetail /> },
              { path: "/referrals", element: <Referrals /> },
              { path: "/users", element: <Users /> },
              { path: "/monitoring", element: <Monitoring /> },
              { path: "/logs", element: <Logs /> },
              { path: "/support", element: <Support /> },
              { path: "/media-review", element: <MediaReview /> },
              { path: "/platform-config", element: <PlatformConfig /> },
              { path: "/promos", element: <Promos /> },
              { path: "/addons", element: <Addons /> },
            ],
          },
        ],
      },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
