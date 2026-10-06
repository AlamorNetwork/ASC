import type { ReactElement } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useSession } from "../contexts/SessionContext";

export default function RequireSession({ children }: { children: ReactElement }) {
  const { session, loading } = useSession();
  const location = useLocation();
  if (loading) return <main className="route-loading" dir="rtl" aria-busy="true">در حال آماده‌سازی فضای پژوهش…</main>;
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return children;
}
