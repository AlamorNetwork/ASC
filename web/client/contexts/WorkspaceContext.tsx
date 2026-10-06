import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import type { WorkspaceState } from "../lib/types";
import { useSession } from "./SessionContext";

type WorkspaceContextValue = {
  state: WorkspaceState | null;
  loading: boolean;
  error: string;
  refresh: (dossierId?: number | null, fresh?: boolean) => Promise<WorkspaceState>;
  selectDossier: (id: number) => Promise<WorkspaceState>;
};

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const [state, setState] = useState<WorkspaceState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async (dossierId?: number | null, fresh = false) => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (dossierId) params.set("dossierId", String(dossierId));
      if (fresh) params.set("fresh", "1");
      const next = await api<WorkspaceState>(`/api/state${params.size ? `?${params}` : ""}`);
      setState(next);
      return next;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "خواندن داده‌ها ناموفق بود.");
      throw caught;
    } finally {
      setLoading(false);
    }
  }, []);

  const selectDossier = useCallback(async (id: number) => {
    await api("/api/select-dossier", { method: "POST", json: { dossierId: id } });
    return refresh(id);
  }, [refresh]);

  useEffect(() => {
    if (!session) { setState(null); return; }
    void refresh().catch(() => undefined);
  }, [session, refresh]);

  useEffect(() => {
    if (!session) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh(state?.selected?.id).catch(() => undefined);
    }, 7000);
    return () => window.clearInterval(timer);
  }, [session, refresh, state?.selected?.id]);

  const value = useMemo(() => ({ state, loading, error, refresh, selectDossier }),
    [state, loading, error, refresh, selectDossier]);
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("WorkspaceProvider is missing");
  return value;
}
