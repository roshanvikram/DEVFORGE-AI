import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Command } from "cmdk";
import { motion, AnimatePresence } from "framer-motion";
import {
  LayoutDashboard, FolderGit2, Network, Layers, Bug, FileSearch, ShieldCheck, GitPullRequest, GitMerge, FlaskConical, History, Boxes, Gauge, Hammer,
  Bot, Workflow, BarChart3, BookOpen, FileText, Activity, Users, Plug, Settings, HelpCircle, Search, Bell, ChevronsUpDown, PanelLeftClose, PanelLeft,
  LogOut, Menu, X, Check, Plus, Circle,
} from "lucide-react";
import { useAuth } from "../lib/auth";
import { useRepo } from "../lib/repo";
import { useRealtime } from "../lib/realtime";
import { get, post } from "../lib/api";
import { timeAgo } from "../lib/format";
import { cx, StatusBadge, Badge, Notice } from "./ui";
import { Logo } from "../pages/public/Site";

export const NAV_SECTIONS: { title?: string; items: { to: string; label: string; icon: any }[] }[] = [
  { items: [{ to: "/app", label: "Command Center", icon: LayoutDashboard }, { to: "/app/projects", label: "Projects", icon: FolderGit2 }] },
  { title: "Understand", items: [{ to: "/app/repository", label: "Repository Intelligence", icon: Network }, { to: "/app/architecture", label: "Architecture", icon: Layers }, { to: "/app/dependencies", label: "Dependency Intelligence", icon: Boxes }] },
  { title: "Detect", items: [{ to: "/app/bugs", label: "Bug Intelligence", icon: Bug }, { to: "/app/investigations", label: "Investigations", icon: FileSearch }, { to: "/app/security", label: "Security Center", icon: ShieldCheck }, { to: "/app/performance", label: "Performance Lab", icon: Gauge }, { to: "/app/debt", label: "Technical Debt", icon: Hammer }] },
  { title: "Change", items: [{ to: "/app/reviews", label: "Code Review", icon: GitPullRequest }, { to: "/app/pulls", label: "Pull Requests", icon: GitMerge }, { to: "/app/tests", label: "Test Forge", icon: FlaskConical }, { to: "/app/regressions", label: "Regression Analysis", icon: History }] },
  { title: "Automate", items: [{ to: "/app/agents", label: "AI Agents", icon: Bot }, { to: "/app/workflows", label: "Workflow Studio", icon: Workflow }] },
  { title: "Insight", items: [{ to: "/app/analytics", label: "Analytics", icon: BarChart3 }, { to: "/app/knowledge", label: "Knowledge Base", icon: BookOpen }, { to: "/app/reports", label: "Reports", icon: FileText }, { to: "/app/activity", label: "Activity", icon: Activity }] },
];
const BOTTOM = [{ to: "/app/team", label: "Team", icon: Users }, { to: "/app/integrations", label: "Integrations", icon: Plug }, { to: "/app/settings", label: "Settings", icon: Settings }, { to: "/app/help", label: "Help", icon: HelpCircle }];

function NavItem({ to, label, icon: I, collapsed, onClick }: { to: string; label: string; icon: any; collapsed: boolean; onClick?: () => void }) {
  return (
    <NavLink to={to} end={to === "/app"} onClick={onClick} title={collapsed ? label : undefined}
      className={({ isActive }) => cx("group relative flex items-center gap-2.5 rounded-[9px] px-2.5 py-[7px] text-[13px] transition", isActive ? "bg-white text-ink shadow-[0_1px_2px_rgba(36,37,33,.06),0_0_0_1px_var(--color-line)]" : "text-muted hover:bg-white/60 hover:text-ink", collapsed && "justify-center px-0")}>
      {({ isActive }) => (
        <>
          {isActive && <span className="absolute left-0 top-1/2 h-4 w-[2.5px] -translate-y-1/2 rounded-full bg-amber" />}
          <I className={cx("size-[16px] shrink-0", isActive ? "text-amber-deep" : "")} strokeWidth={1.8} />
          {!collapsed && <span className="truncate">{label}</span>}
        </>
      )}
    </NavLink>
  );
}

function Sidebar({ collapsed, onToggle, mobile, onNavigate }: { collapsed: boolean; onToggle?: () => void; mobile?: boolean; onNavigate?: () => void }) {
  const { me, workspace, switchWorkspace, logout } = useAuth();
  const [wsOpen, setWsOpen] = useState(false);
  const nav = useNavigate();
  return (
    <aside className={cx("flex h-full flex-col border-r border-line bg-[#F3F2EE]/80 backdrop-blur-xl", collapsed ? "w-[64px]" : "w-[248px]")}>
      <div className={cx("flex h-14 items-center px-3", collapsed ? "justify-center" : "justify-between")}>
        {!collapsed && <Logo />}
        {!mobile && <button onClick={onToggle} className="rounded-lg p-1.5 text-muted hover:bg-white" aria-label="Toggle sidebar">{collapsed ? <PanelLeft className="size-4" /> : <PanelLeftClose className="size-4" />}</button>}
      </div>
      {!collapsed && (
        <div className="relative px-3 pb-2">
          <button onClick={() => setWsOpen(!wsOpen)} className="flex w-full items-center gap-2 rounded-[10px] bg-white px-2.5 py-2 text-left ring-1 ring-line hover:ring-silver">
            <span className="grid size-6 place-items-center rounded-md bg-ink text-[11px] font-semibold text-white">{workspace?.name[0]?.toUpperCase()}</span>
            <span className="min-w-0 flex-1"><span className="block truncate text-[12.5px] font-semibold text-ink">{workspace?.name}</span><span className="block truncate text-[11px] capitalize text-muted">{workspace?.role}</span></span>
            <ChevronsUpDown className="size-3.5 text-faint" />
          </button>
          {wsOpen && (
            <div className="glass-strong absolute inset-x-3 top-full z-30 mt-1 rounded-xl p-1">
              {me?.workspaces.map((w) => <button key={w.id} onClick={() => { setWsOpen(false); switchWorkspace(w.id); nav("/app"); }} className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-[12.5px] hover:bg-ivory"><span className="truncate">{w.name}</span>{w.id === workspace?.id && <Check className="size-3.5 text-amber-deep" />}</button>)}
              <button onClick={() => { setWsOpen(false); nav("/app/team?new=1"); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[12.5px] text-muted hover:bg-ivory"><Plus className="size-3.5" />New workspace</button>
            </div>
          )}
        </div>
      )}
      <nav className="scroll-thin flex-1 space-y-4 overflow-y-auto px-3 py-2">
        {NAV_SECTIONS.map((s, i) => (
          <div key={i}>
            {s.title && !collapsed && <div className="mb-1 px-2.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-faint">{s.title}</div>}
            <div className="space-y-0.5">{s.items.map((it) => <NavItem key={it.to} {...it} collapsed={collapsed} onClick={onNavigate} />)}</div>
          </div>
        ))}
      </nav>
      <div className="space-y-0.5 border-t border-line px-3 py-2">{BOTTOM.map((it) => <NavItem key={it.to} {...it} collapsed={collapsed} onClick={onNavigate} />)}</div>
      <div className={cx("flex items-center gap-2 border-t border-line p-3", collapsed && "justify-center")}>
        <Link to="/app/settings?tab=profile" className="grid size-8 shrink-0 place-items-center rounded-full bg-gradient-to-b from-white to-ivory text-[12px] font-semibold text-ink ring-1 ring-line">{me?.user.name.split(" ").map((x) => x[0]).slice(0, 2).join("")}</Link>
        {!collapsed && <div className="min-w-0 flex-1"><div className="truncate text-[12.5px] font-medium text-ink">{me?.user.name}</div><div className="truncate text-[11px] text-muted">{me?.user.email}</div></div>}
        {!collapsed && <button onClick={logout} className="rounded-lg p-1.5 text-muted hover:bg-white hover:text-ink" title="Sign out" aria-label="Sign out"><LogOut className="size-4" /></button>}
      </div>
    </aside>
  );
}

function RepoSwitcher() {
  const { repos, repo, setRepoId } = useRepo();
  const [open, setOpen] = useState(false);
  if (!repos?.length) return <Link to="/app/projects?new=1" className="hidden items-center gap-1.5 rounded-[10px] bg-white px-3 py-1.5 text-[12.5px] text-ink-2 ring-1 ring-line hover:ring-silver sm:flex"><Plus className="size-3.5" />Connect repository</Link>;
  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)} className="flex max-w-[260px] items-center gap-2 rounded-[10px] bg-white px-3 py-1.5 text-[12.5px] ring-1 ring-line hover:ring-silver">
        <FolderGit2 className="size-3.5 text-muted" /><span className="truncate font-medium text-ink">{repo?.name ?? "Select repository"}</span>
        {repo && repo.status !== "ready" && <StatusBadge status={repo.status} />}
        <ChevronsUpDown className="size-3 text-faint" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="glass-strong absolute left-0 top-full z-30 mt-1 w-72 rounded-xl p-1">
            {repos.map((r) => <button key={r.id} onClick={() => { setRepoId(r.id); setOpen(false); }} className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-[12.5px] hover:bg-ivory"><span className="truncate">{r.name}</span>{r.id === repo?.id ? <Check className="size-3.5 text-amber-deep" /> : r.status !== "ready" ? <StatusBadge status={r.status} /> : null}</button>)}
            <Link to="/app/projects?new=1" onClick={() => setOpen(false)} className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-[12.5px] text-muted hover:bg-ivory"><Plus className="size-3.5" />Connect repository</Link>
          </div>
        </>
      )}
    </div>
  );
}

function Notifications() {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ["notifications"], queryFn: () => get("/notifications"), refetchInterval: 60_000 });
  const markAll = async () => { await post("/notifications/read"); qc.invalidateQueries({ queryKey: ["notifications"] }); };
  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)} className="relative rounded-[10px] p-2 text-muted hover:bg-white hover:text-ink" aria-label="Notifications">
        <Bell className="size-[18px]" />
        {q.data?.unread > 0 && <span className="absolute right-1 top-1 grid min-w-4 place-items-center rounded-full bg-amber px-1 text-[9.5px] font-bold text-white">{q.data.unread > 9 ? "9+" : q.data.unread}</span>}
      </button>
      <AnimatePresence>
        {open && (
          <>
            <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
            <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="glass-strong absolute right-0 top-full z-30 mt-2 w-[360px] overflow-hidden rounded-2xl">
              <div className="flex items-center justify-between border-b border-line-2 px-4 py-3"><span className="text-[13px] font-semibold">Notifications</span><button onClick={markAll} className="text-[12px] text-amber-deep">Mark all read</button></div>
              <div className="scroll-thin max-h-[420px] overflow-y-auto">
                {!q.data?.items?.length && <div className="px-4 py-10 text-center text-[13px] text-muted">You're all caught up.</div>}
                {q.data?.items?.map((n: any) => (
                  <button key={n.id} onClick={async () => { await post("/notifications/read", { ids: [n.id] }); qc.invalidateQueries({ queryKey: ["notifications"] }); setOpen(false); if (n.link) nav(n.link); }} className="flex w-full gap-3 border-b border-line-2 px-4 py-3 text-left hover:bg-white/70">
                    <Circle className={cx("mt-1 size-2 shrink-0", n.read_at ? "text-transparent" : "fill-amber text-amber")} />
                    <div className="min-w-0"><div className="text-[13px] font-medium text-ink">{n.title}</div>{n.body && <div className="truncate text-[12px] text-muted">{n.body}</div>}<div className="mt-0.5 text-[11px] text-faint">{timeAgo(n.created_at)}</div></div>
                  </button>
                ))}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

function CommandPalette({ open, setOpen }: { open: boolean; setOpen: (v: boolean) => void }) {
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const { repo } = useRepo();
  const search = useQuery({ queryKey: ["global-search", q], queryFn: () => get(`/search?q=${encodeURIComponent(q)}`), enabled: open && q.trim().length >= 2 });
  const go = (to: string) => { setOpen(false); setQ(""); nav(to); };
  const actions = [
    { label: "Run full analysis", to: "/app/repository?action=analyze" },
    { label: "Start an investigation", to: "/app/investigations?new=1" },
    { label: "Review a commit", to: "/app/reviews?new=1" },
    { label: "Generate tests", to: "/app/tests?new=1" },
    { label: "Run an agent", to: "/app/agents" },
    { label: "Connect repository", to: "/app/projects?new=1" },
  ];
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-50 bg-[#242521]/20 backdrop-blur-[2px]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={() => setOpen(false)}>
          <motion.div initial={{ y: -10, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="glass-strong mx-auto mt-[12vh] w-[min(640px,92vw)] overflow-hidden rounded-2xl" onMouseDown={(e) => e.stopPropagation()}>
            <Command shouldFilter={false} label="Command palette" className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:text-[10.5px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.12em] [&_[cmdk-group-heading]]:text-faint">
              <div className="flex items-center gap-2 border-b border-line-2 px-4"><Search className="size-4 text-muted" /><Command.Input autoFocus value={q} onValueChange={setQ} placeholder="Search pages, findings, code, docs…" className="h-12 flex-1 bg-transparent text-[14px] outline-none placeholder:text-faint" /><span className="kbd">esc</span></div>
              <Command.List className="scroll-thin max-h-[420px] overflow-y-auto p-2">
                <Command.Empty className="px-3 py-8 text-center text-[13px] text-muted">No results.</Command.Empty>
                {q.trim().length >= 2 && search.data && (
                  <>
                    {search.data.findings?.length > 0 && <Command.Group heading="Findings">{search.data.findings.map((f: any) => <Item key={f.id} onSelect={() => go(`/app/findings/${f.id}`)}><Bug className="size-3.5 text-muted" /><span className="truncate">{f.title}</span><Badge className="ml-auto">{f.severity}</Badge></Item>)}</Command.Group>}
                    {search.data.code?.length > 0 && <Command.Group heading="Code">{search.data.code.map((c: any, i: number) => <Item key={i} onSelect={() => go(`/app/repository?repo=${c.repositoryId}&file=${encodeURIComponent(c.path)}&line=${c.line}`)}><FileText className="size-3.5 text-muted" /><span className="truncate font-mono text-[12px]">{c.path}:{c.line}</span><span className="ml-auto truncate text-[11.5px] text-faint">{c.repository}</span></Item>)}</Command.Group>}
                    {search.data.repositories?.length > 0 && <Command.Group heading="Repositories">{search.data.repositories.map((r: any) => <Item key={r.id} onSelect={() => go(`/app/repository?repo=${r.id}`)}><FolderGit2 className="size-3.5 text-muted" />{r.name}</Item>)}</Command.Group>}
                    {search.data.investigations?.length > 0 && <Command.Group heading="Investigations">{search.data.investigations.map((r: any) => <Item key={r.id} onSelect={() => go(`/app/investigations/${r.id}`)}><FileSearch className="size-3.5 text-muted" />{r.title}</Item>)}</Command.Group>}
                    {search.data.docs?.length > 0 && <Command.Group heading="Knowledge">{search.data.docs.map((r: any) => <Item key={r.id} onSelect={() => go(`/app/knowledge?doc=${r.id}`)}><BookOpen className="size-3.5 text-muted" />{r.title}</Item>)}</Command.Group>}
                  </>
                )}
                <Command.Group heading="Actions">{actions.filter((a) => a.label.toLowerCase().includes(q.toLowerCase())).map((a) => <Item key={a.label} onSelect={() => go(a.to)}><Plus className="size-3.5 text-muted" />{a.label}{a.to.includes("repository") && repo && <span className="ml-auto text-[11.5px] text-faint">{repo.name}</span>}</Item>)}</Command.Group>
                <Command.Group heading="Navigate">{[...NAV_SECTIONS.flatMap((s) => s.items), ...BOTTOM].filter((n) => n.label.toLowerCase().includes(q.toLowerCase())).map((n) => <Item key={n.to} onSelect={() => go(n.to)}><n.icon className="size-3.5 text-muted" />{n.label}</Item>)}</Command.Group>
              </Command.List>
            </Command>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
const Item = ({ children, onSelect }: { children: ReactNode; onSelect: () => void }) => (
  <Command.Item onSelect={onSelect} className="flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] text-ink-2 data-[selected=true]:bg-white data-[selected=true]:text-ink data-[selected=true]:shadow-[0_0_0_1px_var(--color-line)]">{children}</Command.Item>
);

export function AppShell() {
  const { me } = useAuth();
  const { connected } = useRealtime();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("df.sidebar") === "1");
  const [mobile, setMobile] = useState(false);
  const [palette, setPalette] = useState(false);
  const loc = useLocation();
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette((v) => !v); }
      if (e.key === "Escape") setPalette(false);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
  useEffect(() => setMobile(false), [loc.pathname]);
  const crumbs = (() => {
    const all = [...NAV_SECTIONS.flatMap((s) => s.items), ...BOTTOM];
    const match = all.filter((n) => loc.pathname === n.to || (n.to !== "/app" && loc.pathname.startsWith(n.to))).sort((a, b) => b.to.length - a.to.length)[0];
    const extra = match && loc.pathname.length > match.to.length + 1 ? loc.pathname.slice(match.to.length + 1).split("/")[0] : null;
    return [match?.label ?? (loc.pathname.startsWith("/app/findings") ? "Finding" : "Command Center"), extra && extra.length > 3 ? "Detail" : null].filter(Boolean) as string[];
  })();
  return (
    <div className="pearl-canvas flex h-full">
      <div className="hidden h-full lg:block"><Sidebar collapsed={collapsed} onToggle={() => { setCollapsed(!collapsed); localStorage.setItem("df.sidebar", collapsed ? "0" : "1"); }} /></div>
      <AnimatePresence>
        {mobile && (
          <motion.div className="fixed inset-0 z-40 lg:hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="absolute inset-0 bg-black/20" onClick={() => setMobile(false)} />
            <motion.div initial={{ x: -260 }} animate={{ x: 0 }} exit={{ x: -260 }} className="relative h-full w-[248px]"><Sidebar collapsed={false} mobile onNavigate={() => setMobile(false)} /></motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-pearl/70 px-4 backdrop-blur-xl md:px-6">
          <button className="rounded-lg p-1.5 lg:hidden" onClick={() => setMobile(true)} aria-label="Open navigation"><Menu className="size-5" /></button>
          <nav aria-label="Breadcrumb" className="hidden items-center gap-1.5 text-[13px] md:flex"><Link to="/app" className="text-muted hover:text-ink">DevForge</Link>{crumbs.map((c) => <span key={c} className="flex items-center gap-1.5"><span className="text-faint">/</span><span className="text-ink">{c}</span></span>)}</nav>
          <div className="ml-auto flex items-center gap-2">
            <RepoSwitcher />
            <button onClick={() => setPalette(true)} className="hidden h-8 w-56 items-center gap-2 rounded-[10px] bg-white px-3 text-[12.5px] text-faint ring-1 ring-line hover:ring-silver md:flex"><Search className="size-3.5" />Search…<span className="kbd ml-auto">⌘K</span></button>
            <button onClick={() => setPalette(true)} className="rounded-lg p-2 md:hidden" aria-label="Search"><Search className="size-4" /></button>
            <span title={connected ? "Live updates connected" : "Live updates disconnected"} className={cx("size-2 rounded-full", connected ? "bg-success" : "bg-silver")} />
            <Notifications />
          </div>
        </header>
        {me && !me.user.email_verified_at && <div className="border-b border-amber/30 bg-amber-soft/40 px-6 py-1.5 text-[12.5px] text-ink-2">Please verify your email address. <button className="font-medium text-amber-deep underline" onClick={() => post("/auth/verify-email/request").then(() => alert("Verification email sent."))}>Resend email</button></div>}
        <main className="scroll-thin flex-1 overflow-y-auto">
          <motion.div key={loc.pathname} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }} className="mx-auto max-w-[1400px] px-4 py-6 md:px-8 md:py-8">
            <Outlet />
          </motion.div>
        </main>
      </div>
      <CommandPalette open={palette} setOpen={setPalette} />
    </div>
  );
}

/** Shown on pages that need a selected, indexed repository. */
export function NeedsRepo({ children }: { children: (repo: NonNullable<ReturnType<typeof useRepo>["repo"]>) => ReactNode }) {
  const { repo, repos, loading } = useRepo();
  if (loading) return <div className="skeleton h-40" />;
  if (!repos?.length) return (
    <div className="panel">
      <div className="flex flex-col items-center px-6 py-16 text-center">
        <FolderGit2 className="size-8 text-faint" />
        <h3 className="mt-4 text-[16px] font-semibold">No repository connected</h3>
        <p className="mt-1.5 max-w-md text-[13px] text-muted">Connect a repository to see real analysis here. DevForge never displays sample data in your workspace.</p>
        <Link to="/app/projects?new=1" className="mt-5"><span className="inline-flex h-9 items-center gap-2 rounded-[10px] bg-ink px-4 text-[13.5px] font-medium text-white"><Plus className="size-4" />Connect repository</span></Link>
      </div>
    </div>
  );
  if (!repo) return null;
  if (!repo.stats && repo.status !== "ready") return <div className="panel p-6"><Notice tone="amber">{repo.name} is {repo.status}. {repo.error ?? "Results will appear when indexing completes."}</Notice></div>;
  return <>{children(repo)}</>;
}
