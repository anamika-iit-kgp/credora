import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, getToken, onUnauthorized, setToken } from "../api/client";
import type { LoginResponse, User } from "../api/types";

interface AuthState {
  user: User | null;
  ready: boolean;
  login: (username: string, password: string) => Promise<User>;
  logout: () => void;
}

const Ctx = createContext<AuthState | null>(null);
const USER_KEY = "credora.user";

function storedUser(): User | null {
  try {
    const raw = sessionStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as User) : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [user, setUser] = useState<User | null>(() => (getToken() ? storedUser() : null));
  const [ready, setReady] = useState(() => !getToken() || !!storedUser());

  const logout = useCallback(() => {
    setToken(null);
    try {
      sessionStorage.removeItem(USER_KEY);
    } catch {
      /* ignore */
    }
    setUser(null);
    qc.clear();
  }, [qc]);

  useEffect(() => onUnauthorized(logout), [logout]);

  // Confirm the stored session against /api/me once on load.
  useEffect(() => {
    if (!getToken()) return;
    let live = true;
    api<User>("/me")
      .then((u) => {
        if (!live) return;
        setUser(u);
        sessionStorage.setItem(USER_KEY, JSON.stringify(u));
      })
      .catch(() => live && logout())
      .finally(() => live && setReady(true));
    return () => {
      live = false;
    };
  }, [logout]);

  const login = useCallback(
    async (username: string, password: string) => {
      const res = await api<LoginResponse>("/auth/login", { body: { username, password } });
      setToken(res.token);
      sessionStorage.setItem(USER_KEY, JSON.stringify(res.user));
      qc.clear();
      setUser(res.user);
      setReady(true);
      return res.user;
    },
    [qc],
  );

  const value = useMemo(() => ({ user, ready, login, logout }), [user, ready, login, logout]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}

/** For pages behind RequireAuth: the user is always present. */
export function useUser(): User {
  const { user } = useAuth();
  if (!user) throw new Error("useUser without a signed-in user");
  return user;
}
