import { Component, lazy, Suspense, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./lib/auth";
import { RealtimeProvider } from "./lib/realtime";
import { RepoProvider } from "./lib/repo";
import { AppShell } from "./components/AppShell";
import { SiteLayout, Landing, FeaturesPage, AgentsPage, HowItWorksPage, SecurityPage, DocsPage, PricingPage } from "./pages/public/Site";
import { LoginPage, SignupPage, ForgotPasswordPage, ResetPasswordPage, VerifyEmailPage, AcceptInvitePage } from "./pages/public/Auth";
import { Button, LoadingBlock, ErrorState } from "./components/ui";

const Onboarding = lazy(() => import("./pages/Onboarding"));
const CommandCenter = lazy(() => import("./pages/app/CommandCenter"));
const Projects = lazy(() => import("./pages/app/Projects"));
const Repository = lazy(() => import("./pages/app/Repository"));
const Architecture = lazy(() => import("./pages/app/Architecture"));
const F = () => import("./pages/app/Findings");
const BugsPage = lazy(() => F().then((m) => ({ default: m.BugsPage })));
const PerformancePage = lazy(() => F().then((m) => ({ default: m.PerformancePage })));
const DebtPage = lazy(() => F().then((m) => ({ default: m.DebtPage })));
const FindingDetailPage = lazy(() => F().then((m) => ({ default: m.FindingDetailPage })));
const Security = lazy(() => import("./pages/app/Security"));
const I = () => import("./pages/app/Investigations");
const Investigations = lazy(() => I().then((m) => ({ default: m.InvestigationsPage })));
const InvestigationDetail = lazy(() => I().then((m) => ({ default: m.InvestigationDetail })));
const R = () => import("./pages/app/Reviews");
const Reviews = lazy(() => R().then((m) => ({ default: m.ReviewsPage })));
const ReviewDetail = lazy(() => R().then((m) => ({ default: m.ReviewDetail })));
const Pulls = lazy(() => R().then((m) => ({ default: m.PullRequestsPage })));
const T = () => import("./pages/app/Tests");
const Tests = lazy(() => T().then((m) => ({ default: m.TestsPage })));
const Regressions = lazy(() => T().then((m) => ({ default: m.RegressionsPage })));
const Dependencies = lazy(() => import("./pages/app/Dependencies"));
const A = () => import("./pages/app/Agents");
const Agents = lazy(() => A().then((m) => ({ default: m.AgentsPage })));
const AgentRun = lazy(() => A().then((m) => ({ default: m.AgentRunPage })));
const Workflows = lazy(() => import("./pages/app/Workflows"));
const Analytics = lazy(() => import("./pages/app/Analytics"));
const K = () => import("./pages/app/Knowledge");
const Knowledge = lazy(() => K().then((m) => ({ default: m.KnowledgePage })));
const Reports = lazy(() => K().then((m) => ({ default: m.ReportsPage })));
const Activity = lazy(() => K().then((m) => ({ default: m.ActivityPage })));
const Ad = () => import("./pages/app/Admin");
const Team = lazy(() => Ad().then((m) => ({ default: m.TeamPage })));
const Integrations = lazy(() => Ad().then((m) => ({ default: m.IntegrationsPage })));
const Settings = lazy(() => Ad().then((m) => ({ default: m.SettingsPage })));
const Live = lazy(() => import("./pages/app/Live"));
const Gates = lazy(() => import("./pages/app/Gates"));
const Sync = lazy(() => import("./pages/app/Sync"));
const Help = lazy(() => Ad().then((m) => ({ default: m.HelpPage })));

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="panel mx-auto mt-10 max-w-lg p-8 text-center">
        <h2 className="text-[17px] font-semibold">This page hit an unexpected error</h2>
        <p className="mt-2 text-[13px] text-muted">{this.state.error.message}</p>
        <Button className="mt-5" onClick={() => { this.setState({ error: null }); location.reload(); }}>Reload</Button>
      </div>
    );
  }
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { me, authError, retryAuth } = useAuth();
  const loc = useLocation();
  if (me === undefined) return <div className="p-10">{authError ? <ErrorState error={authError} retry={retryAuth} /> : <LoadingBlock />}</div>;
  if (!me) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return <>{children}</>;
}

function AppGate() {
  const { me } = useAuth();
  if (me && !me.workspaces.length) return <Navigate to="/onboarding" replace />;
  return (
    <RealtimeProvider>
      <RepoProvider>
        <AppShell />
      </RepoProvider>
    </RealtimeProvider>
  );
}

const page = (el: ReactNode) => <ErrorBoundary><Suspense fallback={<LoadingBlock rows={6} />}>{el}</Suspense></ErrorBoundary>;

export default function App() {
  return (
    <Routes>
      <Route element={<SiteLayout />}>
        <Route index element={<Landing />} />
        <Route path="features" element={<FeaturesPage />} />
        <Route path="agents" element={<AgentsPage />} />
        <Route path="how-it-works" element={<HowItWorksPage />} />
        <Route path="security" element={<SecurityPage />} />
        <Route path="documentation" element={<DocsPage />} />
        <Route path="pricing" element={<PricingPage />} />
      </Route>
      <Route path="login" element={<LoginPage />} />
      <Route path="signup" element={<SignupPage />} />
      <Route path="forgot-password" element={<ForgotPasswordPage />} />
      <Route path="reset-password" element={<ResetPasswordPage />} />
      <Route path="verify-email" element={<VerifyEmailPage />} />
      <Route path="accept-invite" element={<AcceptInvitePage />} />
      <Route path="onboarding" element={<RequireAuth>{page(<Onboarding />)}</RequireAuth>} />
      <Route path="app" element={<RequireAuth><AppGate /></RequireAuth>}>
        <Route index element={page(<CommandCenter />)} />
        <Route path="projects" element={page(<Projects />)} />
        <Route path="repository" element={page(<Repository />)} />
        <Route path="architecture" element={page(<Architecture />)} />
        <Route path="bugs" element={page(<BugsPage />)} />
        <Route path="findings/:id" element={page(<FindingDetailPage />)} />
        <Route path="investigations" element={page(<Investigations />)} />
        <Route path="investigations/:id" element={page(<InvestigationDetail />)} />
        <Route path="security" element={page(<Security />)} />
        <Route path="reviews" element={page(<Reviews />)} />
        <Route path="reviews/:id" element={page(<ReviewDetail />)} />
        <Route path="pulls" element={page(<Pulls />)} />
        <Route path="tests" element={page(<Tests />)} />
        <Route path="regressions" element={page(<Regressions />)} />
        <Route path="dependencies" element={page(<Dependencies />)} />
        <Route path="performance" element={page(<PerformancePage />)} />
        <Route path="debt" element={page(<DebtPage />)} />
        <Route path="agents" element={page(<Agents />)} />
        <Route path="agents/runs/:id" element={page(<AgentRun />)} />
        <Route path="workflows" element={page(<Workflows />)} />
        <Route path="analytics" element={page(<Analytics />)} />
        <Route path="knowledge" element={page(<Knowledge />)} />
        <Route path="reports" element={page(<Reports />)} />
        <Route path="activity" element={page(<Activity />)} />
        <Route path="team" element={page(<Team />)} />
        <Route path="integrations" element={page(<Integrations />)} />
        <Route path="settings" element={page(<Settings />)} />
        <Route path="help" element={page(<Help />)} />
        <Route path="live" element={page(<Live />)} />
        <Route path="gates" element={page(<Gates />)} />
        <Route path="sync" element={page(<Sync />)} />
        <Route path="*" element={<Navigate to="/app" replace />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
