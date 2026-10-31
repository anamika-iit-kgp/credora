import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense, type ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { ApiError } from "./api/client";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { Shell } from "./components/Shell";
import { Empty, Loading } from "./components/ui";
import { can, type Permission } from "./lib/roles";

// Each screen is its own chunk, so the first paint only downloads what it shows.
const LoginPage = lazy(() => import("./pages/Login").then((m) => ({ default: m.LoginPage })));
const OverviewPage = lazy(() => import("./pages/Overview").then((m) => ({ default: m.OverviewPage })));
const DataGenerationPage = lazy(() => import("./pages/admin/DataGeneration").then((m) => ({ default: m.DataGenerationPage })));
const SourcesPage = lazy(() => import("./pages/admin/Sources").then((m) => ({ default: m.SourcesPage })));
const AuditPage = lazy(() => import("./pages/admin/Audit").then((m) => ({ default: m.AuditPage })));
const ExasolAuditPage = lazy(() => import("./pages/admin/ExasolAudit").then((m) => ({ default: m.ExasolAuditPage })));
const ApprovalsPage = lazy(() => import("./pages/admin/Approvals").then((m) => ({ default: m.ApprovalsPage })));
const LoanStatusPage = lazy(() => import("./pages/book/LoanStatus").then((m) => ({ default: m.LoanStatusPage })));
const MyBookPage = lazy(() => import("./pages/book/MyBook").then((m) => ({ default: m.MyBookPage })));
const CompaniesPage = lazy(() => import("./pages/explorer/Companies").then((m) => ({ default: m.CompaniesPage })));
const CompanyPage = lazy(() => import("./pages/explorer/Company").then((m) => ({ default: m.CompanyPage })));
const ReportPage = lazy(() => import("./pages/report/Report").then((m) => ({ default: m.ReportPage })));
const RunsPage = lazy(() => import("./pages/analysis/Runs").then((m) => ({ default: m.RunsPage })));
const DecisionsPage = lazy(() => import("./pages/analysis/Decisions").then((m) => ({ default: m.DecisionsPage })));
const Top50Page = lazy(() => import("./pages/analysis/Top50").then((m) => ({ default: m.Top50Page })));
const ModelsPage = lazy(() => import("./pages/models/Models").then((m) => ({ default: m.ModelsPage })));
const WhatIfPage = lazy(() => import("./pages/models/WhatIf").then((m) => ({ default: m.WhatIfPage })));
const PipelinePage = lazy(() => import("./pages/offers/Pipeline").then((m) => ({ default: m.PipelinePage })));
const OfferPage = lazy(() => import("./pages/offers/Offer").then((m) => ({ default: m.OfferPage })));
const QueuePage = lazy(() => import("./pages/offers/Queue").then((m) => ({ default: m.QueuePage })));
const AskPage = lazy(() => import("./pages/ask/Ask").then((m) => ({ default: m.AskPage })));
const ControlRoomPage = lazy(() => import("./pages/exasol/ControlRoom").then((m) => ({ default: m.ControlRoomPage })));
const GlossaryPage = lazy(() => import("./pages/glossary/Glossary").then((m) => ({ default: m.GlossaryPage })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 20_000,
      refetchOnWindowFocus: false,
      retry: (n, e) => {
        const s = (e as ApiError).status;
        return s !== 401 && s !== 403 && s !== 404 && n < 2;
      },
    },
  },
});

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, ready } = useAuth();
  const loc = useLocation();
  if (!ready) return <Loading label="Checking your session" rows={3} />;
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return <>{children}</>;
}

function Gate({ perm, children }: { perm: Permission; children: ReactNode }) {
  const { user } = useAuth();
  if (!can(user?.role, perm))
    return (
      <div className="page">
        <Empty title="Your role does not include this screen">Sign in as a user with the right role to open it.</Empty>
      </div>
    );
  return <>{children}</>;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <Suspense fallback={<Loading label="Opening" rows={4} />}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              element={
                <RequireAuth>
                  <Shell />
                </RequireAuth>
              }
            >
              <Route index element={<OverviewPage />} />
              <Route path="companies" element={<CompaniesPage />} />
              <Route path="companies/:cif" element={<CompanyPage />} />
              <Route path="companies/:cif/report" element={<Gate perm="report"><ReportPage /></Gate>} />
              <Route path="analysis" element={<Gate perm="runs"><RunsPage /></Gate>} />
              <Route path="analysis/decisions" element={<Gate perm="decisions"><DecisionsPage /></Gate>} />
              <Route path="analysis/top50" element={<Gate perm="top50"><Top50Page /></Gate>} />
              <Route path="status" element={<Gate perm="loanStatus"><LoanStatusPage /></Gate>} />
              <Route path="book" element={<Gate perm="myBook"><MyBookPage /></Gate>} />
              <Route path="models" element={<Gate perm="models"><ModelsPage /></Gate>} />
              <Route path="models/whatif" element={<Gate perm="whatif"><WhatIfPage /></Gate>} />
              <Route path="ask" element={<Gate perm="ask"><AskPage /></Gate>} />
              <Route path="exasol" element={<ControlRoomPage />} />
              <Route path="glossary" element={<GlossaryPage />} />
              <Route path="pipeline" element={<Gate perm="offers"><PipelinePage /></Gate>} />
              <Route path="offers/:offerId" element={<Gate perm="offers"><OfferPage /></Gate>} />
              <Route path="queue" element={<Gate perm="checker"><QueuePage /></Gate>} />
              <Route path="admin/data" element={<Gate perm="generate"><DataGenerationPage /></Gate>} />
              <Route path="admin/sources" element={<Gate perm="sources"><SourcesPage /></Gate>} />
              <Route path="admin/audit" element={<Gate perm="audit"><AuditPage /></Gate>} />
              <Route path="admin/exasol-audit" element={<Gate perm="audit"><ExasolAuditPage /></Gate>} />
              <Route path="admin/approvals" element={<Gate perm="approvePolicy"><ApprovalsPage /></Gate>} />
              <Route path="admin/policy" element={<Navigate to="/admin/approvals" replace />} />
              <Route
                path="*"
                element={
                  <div className="page">
                    <Empty title="No page at this address">Use the menu to find what you need.</Empty>
                  </div>
                }
              />
            </Route>
          </Routes>
          </Suspense>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
