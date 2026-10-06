import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, readSession, setCsrf } from "../lib/api";
import type { SessionPayload } from "../lib/types";

type SessionContextValue = {
  session: SessionPayload | null;
  loading: boolean;
  refresh: () => Promise<SessionPayload | null>;
  login: (input: { email?: string; password: string }) => Promise<SessionPayload>;
  signup: (input: { displayName: string; email: string; password: string }) => Promise<SessionPayload>;
  logout: () => Promise<void>;
};

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const next = await readSession();
      setSession(next);
      return next;
    } catch (error) {
      if ((error as Error & { status?: number }).status === 401) {
        setSession(null);
        setCsrf("");
        return null;
      }
      throw error;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const login = useCallback(async (input: { email?: string; password: string }) => {
    const next = await api<SessionPayload>("/api/login", { method: "POST", json: input });
    setCsrf(next.csrf);
    setSession(next);
    return next;
  }, []);

  const signup = useCallback(async (input: { displayName: string; email: string; password: string }) => {
    const next = await api<SessionPayload>("/api/signup", { method: "POST", json: input });
    setCsrf(next.csrf);
    setSession(next);
    return next;
  }, []);

  const logout = useCallback(async () => {
    await api("/api/logout", { method: "POST", json: {} });
    setCsrf("");
    setSession(null);
  }, []);

  const value = useMemo(() => ({ session, loading, refresh, login, signup, logout }),
    [session, loading, refresh, login, signup, logout]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error("SessionProvider is missing");
  return value;
}
