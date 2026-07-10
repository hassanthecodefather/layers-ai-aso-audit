import { createContext, useCallback, useContext, useMemo, useState } from 'react';

interface AuthState {
  userId: string | null;
  accessToken: string | null;
}

interface AuthContextValue extends AuthState {
  signup: (email: string, password: string) => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshToken: () => Promise<string | null>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [auth, setAuth] = useState<AuthState>({ userId: null, accessToken: null });

  const signup = useCallback(async (email: string, password: string) => {
    const res = await fetch('/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => ({})) as Record<string, string>;
    if (!res.ok) throw new Error(data.error ?? 'Signup failed.');
    setAuth({ userId: data.userId ?? null, accessToken: data.accessToken ?? null });
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => ({})) as Record<string, string>;
    if (!res.ok) throw new Error(data.error ?? 'Login failed.');
    setAuth({ userId: data.userId ?? null, accessToken: data.accessToken ?? null });
  }, []);

  const logout = useCallback(async () => {
    await fetch('/auth/logout', { method: 'POST' }).catch(() => {});
    setAuth({ userId: null, accessToken: null });
  }, []);

  const refreshToken = useCallback(async (): Promise<string | null> => {
    const res = await fetch('/auth/refresh', { method: 'POST' });
    if (!res.ok) {
      setAuth({ userId: null, accessToken: null });
      return null;
    }
    const data = await res.json();
    setAuth((prev) => ({ ...prev, accessToken: data.accessToken }));
    return data.accessToken as string;
  }, []);

  const value = useMemo(
    () => ({ ...auth, signup, login, logout, refreshToken }),
    [auth, signup, login, logout, refreshToken],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
