import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import { auth } from "../lib/api";

interface User {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  role: string;
  siteId: string;
  globalRole?: string;
}

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem("ap_token");
    if (!token) {
      setLoading(false);
      return;
    }

    auth
      .me()
      .then((res) => {
        if (res.user.globalRole !== "cadmus_admin") {
          localStorage.removeItem("ap_token");
          return;
        }
        setUser(res.user);
      })
      .catch(() => {
        localStorage.removeItem("ap_token");
      })
      .finally(() => setLoading(false));
  }, []);

  const loginFn = async (email: string, password: string) => {
    const res = await auth.login(email, password);
    if (res.user.globalRole !== "cadmus_admin") {
      throw new Error("Access restricted to platform administrators");
    }
    localStorage.setItem("ap_token", res.token);
    setUser(res.user);
  };

  const logout = () => {
    localStorage.removeItem("ap_token");
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login: loginFn, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
