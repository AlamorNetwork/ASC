import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { GlobalContextProviders } from "./components/_globalContextProviders";
import RequireSession from "./components/RequireSession";
import { SessionProvider } from "./contexts/SessionContext";
import { WorkspaceProvider } from "./contexts/WorkspaceContext";
import LandingPage from "./pages/_index";
import AgentsPage from "./pages/agents";
import DashboardPage from "./pages/dashboard";
import DossiersPage from "./pages/dossiers";
import EvidencePage from "./pages/evidence";
import LoginPage from "./pages/login";
import SettingsPage from "./pages/settings";
import SourcesPage from "./pages/sources";
import "./base.css";

function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/dossiers" element={<RequireSession><DossiersPage /></RequireSession>} />
      <Route path="/dashboard" element={<RequireSession><DashboardPage /></RequireSession>} />
      <Route path="/sources" element={<RequireSession><SourcesPage /></RequireSession>} />
      <Route path="/agents" element={<RequireSession><AgentsPage /></RequireSession>} />
      <Route path="/evidence" element={<RequireSession><EvidencePage /></RequireSession>} />
      <Route path="/settings" element={<RequireSession><SettingsPage /></RequireSession>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <GlobalContextProviders>
        <SessionProvider>
          <WorkspaceProvider>
            <App />
          </WorkspaceProvider>
        </SessionProvider>
      </GlobalContextProviders>
    </BrowserRouter>
  </StrictMode>,
);
