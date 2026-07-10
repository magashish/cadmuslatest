import { createBrowserRouter, RouterProvider, Outlet } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext";
import { AdminLayout } from "./layouts/AdminLayout";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { PartnerHome } from "./pages/PartnerHome";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Login } from "./pages/Login";
import { Signup } from "./pages/Signup";
import { SubdomainSetup } from "./pages/SubdomainSetup";
import { VerifyEmail } from "./pages/VerifyEmail";
import { ForgotPassword } from "./pages/ForgotPassword";
import { ResetPassword } from "./pages/ResetPassword";
import { Onboarding } from "./pages/Onboarding";
import { Dashboard } from "./pages/Dashboard";
import { ContentList } from "./pages/ContentList";
import { ContentEditor } from "./pages/ContentEditor";
import { MediaLibrary } from "./pages/MediaLibrary";
import { SiteSettings } from "./pages/SiteSettings";
import { Collections } from "./pages/Collections";
import { Style } from "./pages/Style";
import { FormSubmissions } from "./pages/FormSubmissions";
import { Account } from "./pages/Account";
import { Team } from "./pages/Team";
import { AuditLog } from "./pages/AuditLog";
import { Insights } from "./pages/Insights";
import { AcceptInvite } from "./pages/AcceptInvite";
import { Help } from "./pages/Help";
import { Redirects } from "./pages/Redirects";
import { SEO } from "./pages/SEO";
import { Addons } from "./pages/Addons";

function AuthRoot() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <Outlet />
      </AuthProvider>
    </ErrorBoundary>
  );
}

const router = createBrowserRouter(
  [
    {
      element: <AuthRoot />,
      children: [
        { path: "/login", element: <Login /> },
        { path: "/signup", element: <Signup /> },
        { path: "/signup/subdomain", element: <SubdomainSetup /> },
        { path: "/verify-email", element: <VerifyEmail /> },
        { path: "/forgot-password", element: <ForgotPassword /> },
        { path: "/reset-password", element: <ResetPassword /> },
        { path: "/onboarding", element: <Onboarding /> },
        { path: "/accept-invite", element: <AcceptInvite /> },
        {
          element: <ProtectedRoute />,
          children: [
            { path: "/partner", element: <PartnerHome /> },
            {
              element: <AdminLayout />,
              children: [
                { path: "/", element: <Dashboard /> },
                { path: "/content", element: <ContentList /> },
                { path: "/content/new", element: <ContentEditor /> },
                { path: "/content/:id", element: <ContentEditor /> },
                { path: "/collections", element: <Collections /> },
                { path: "/theme", element: <Style /> },
                { path: "/seo", element: <SEO /> },
                { path: "/addons", element: <Addons /> },
                { path: "/media", element: <MediaLibrary /> },
                { path: "/forms", element: <FormSubmissions /> },
                { path: "/activity", element: <AuditLog /> },
                { path: "/insights", element: <Insights /> },
                { path: "/settings", element: <SiteSettings /> },
                { path: "/team", element: <Team /> },
                { path: "/account", element: <Account /> },
                { path: "/help", element: <Help /> },
                { path: "/redirects", element: <Redirects /> },
              ],
            },
          ],
        },
      ],
    },
  ],
  { basename: "/admin" }
);

export function App() {
  return <RouterProvider router={router} />;
}
