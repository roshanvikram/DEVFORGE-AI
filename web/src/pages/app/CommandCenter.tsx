import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Bug, ShieldCheck, FlaskConical, GitPullRequest, FileSearch, ScanSearch, ArrowRight, Boxes, Activity, Bot, FolderGit2, Plus, Sparkles } from "lucide-react";
import { get, post } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useRepo } from "../../lib/repo";
import { HealthPanel } from "../../components/health";
import { PageHeader, Panel, Stat, HealthRing, Button, EmptyState, ErrorState, LoadingBlock, SeverityBadge, StatusBadge, Badge, Notice } from "../../components/ui";
import { JobPanel, useActiveJobs } from "../../components/jobs";
import { SEV_COLOR, SEVERITIES, timeAgo, num, titleCase } from "../../lib/format";

export default function CommandCenter() {
  const { me, can } = useAuth();
  const { repo, repos } = useRepo();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ["dashboard", repo?.id], queryFn: () => get(`/dashboard${repo ? `?repo=${repo.id}` : ""}`), enabled: repos !== undefined });
  const caps = useQuery({ queryKey: ["capabilities"], queryFn: () => get("/system/capabilities"), staleTime: 60_000 });
  const jobs = useActiveJobs((j) => !repo || j.payload?.repositoryId === repo.id);
  const commits = useQuery({ queryKey: ["commits", repo?.id], queryFn: () => get(`/repositories/${repo!.id}/commits`), enabled: !!repo?.stats });

  const run = async (kinds: string[] | null, label: string) => {
    if (!repo) return;
    try {
      await post(`/repositories/${repo.id}/analyze`, kinds ? { kinds } : { preset: "full" });
      toast.success(`${label} started`);
    } catch (e: any) { toast.error(e.message); }
  };

  if (repos && !repos.length) {
    return (
      <>
        <PageHeader eyebrow="Command Center" title={`Good to see you, ${me?.user.name.split(" ")[0]}.`} description="Connect a repository to start. Every metric here is computed from real analysis of your code — nothing is shown until there's data." />
        <div className="panel overflow-hidden">
          <EmptyState icon={<FolderGit2 className="size-5" />} title="No repositories yet" description="Import a repository from GitHub or any https Git URL. DevForge indexes it and runs your chosen analysis." action={<Link to="/app/projects?new=1"><Button variant="primary" icon={<Plus className="size-4" />}>Connect a repository</Button></Link>} />
        </div>
      </>
    );
  }
  if (q.isLoading) return <LoadingBlock rows={8} />;
  if (q.error) return <ErrorState error={q.error} retry={q.refetch} />;
  const d = q.data;
  const r = d?.repositories?.[0];
  const sev = SEVERITIES.map((s) => ({ name: s, value: d?.findings?.bySeverity?.[s] ?? 0 })).filter((x) => x.value);
  const bySource = Object.entries(d?.findings?.bySource ?? {}).map(([k, v]: any) => ({ name: titleCase(k), ...v }));
  const security = ["security", "secret", "dependency"].reduce((a, s) => a + Object.values(d?.findings?.bySource?.[s] ?? {}).reduce((x: number, y: any) => x + y, 0), 0);
  const bugs = Object.values(d?.findings?.bySource?.bug ?? {}).reduce((x: number, y: any) => x + y, 0);
  const debt = Object.values(d?.findings?.bySource?.debt ?? {}).reduce((x: number, y: any) => x + y, 0);
  const lastTests = d?.tests?.[0];
  const recommended = (d?.topFindings ?? []).slice(0, 5);

  return (
    <>
      <PageHeader eyebrow="Command Center" title={repo?.name ?? "Engineering overview"} description={r?.lastAnalyzedAt ? <>Last analysed {timeAgo(r.lastAnalyzedAt)}{r.commit && <> at <span className="font-mono text-[12.5px]">{r.commit.slice(0, 8)}</span></>} · {r.frameworks.slice(0, 5).join(" · ") || "no frameworks detected"}</> : "Waiting for the first analysis."}
        actions={can("analysis.run") && repo && (
          <>
            <Button icon={<ScanSearch className="size-4" />} onClick={() => run(null, "Full analysis")}>Analyze repository</Button>
            <Button variant="primary" icon={<Sparkles className="size-4" />} onClick={() => nav("/app/agents")}>Run an agent</Button>
          </>
        )} />

      {jobs.length > 0 && <div className="mb-6 space-y-2">{jobs.slice(0, 2).map((j: any) => <JobPanel key={j.id} jobId={j.id} compact />)}</div>}
      {caps.data && !caps.data.ai.configured && <div className="mb-6"><Notice tone="info" icon={<Sparkles className="size-4 text-info" />}>Static analysis is fully active. AI hypotheses, AI review, test generation and Q&A need an AI provider key (Claude or Groq) — <Link className="font-medium text-amber-deep underline" to="/app/integrations">connect one</Link>.</Notice></div>}

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        {repo ? <HealthPanel repoId={repo.id} /> : <Panel><HealthRing score={null} size={150} /></Panel>}
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Stat label="Open bugs" value={num(bugs)} icon={<Bug className="size-4" />} tone={bugs ? "amber" : undefined} sub={<Link to="/app/bugs" className="hover:text-ink">Bug Intelligence →</Link>} />
          <Stat label="Security risks" value={num(security)} icon={<ShieldCheck className="size-4" />} tone={security ? "danger" : "success"} sub={<Link to="/app/security" className="hover:text-ink">Security Center →</Link>} />
          <Stat label="Tech-debt items" value={num(debt)} icon={<Activity className="size-4" />} sub={<Link to="/app/debt" className="hover:text-ink">Technical Debt →</Link>} />
          <Stat label="Dependencies" value={r?.dependencies ? num(r.dependencies.total) : "—"} icon={<Boxes className="size-4" />} sub={r?.dependencies ? `${r.dependencies.vulnerable} vulnerable · ${r.dependencies.outdated} behind latest` : "Run a dependency scan"} />
          <Stat label="Codebase" value={r?.size ? num(r.size.loc) : "—"} sub={r?.size ? `${num(r.size.codeFiles)} code files · LOC` : undefined} />
          <Stat label="Test file ratio" value={r?.testFileRatio != null ? `${r.testFileRatio}%` : "—"} sub="Test files / code files (not coverage)" icon={<FlaskConical className="size-4" />} />
          <Stat label="Last test run" value={lastTests ? `${lastTests.passed}/${lastTests.passed + lastTests.failed}` : "—"} sub={lastTests ? `passed · ${timeAgo(lastTests.created_at)}` : "No executed tests yet"} tone={lastTests?.failed ? "danger" : lastTests ? "success" : undefined} />
          <Stat label="Agent runs (30d)" value={num((d?.agentRuns ?? []).reduce((a: number, x: any) => a + x.n, 0))} icon={<Bot className="size-4" />} sub={<Link to="/app/agents" className="hover:text-ink">Agent Center →</Link>} />
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Panel title="Findings trend" subtitle="Opened vs resolved per day, last 30 days" className="lg:col-span-2">
          {d?.trend?.length ? (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={d.trend} margin={{ left: -20, right: 6, top: 6 }}>
                <defs>
                  <linearGradient id="go" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#D99A28" stopOpacity={0.35} /><stop offset="1" stopColor="#D99A28" stopOpacity={0} /></linearGradient>
                  <linearGradient id="gr" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#23966A" stopOpacity={0.3} /><stop offset="1" stopColor="#23966A" stopOpacity={0} /></linearGradient>
                </defs>
                <CartesianGrid stroke="#EFECE5" vertical={false} />
                <XAxis dataKey="day" tick={{ fontSize: 11, fill: "#A3A199" }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 11, fill: "#A3A199" }} tickLine={false} axisLine={false} allowDecimals={false} />
                <Tooltip contentStyle={{ borderRadius: 10, border: "1px solid #E7E3DA", fontSize: 12 }} />
                <Area type="monotone" dataKey="opened" stroke="#D99A28" fill="url(#go)" strokeWidth={2} />
                <Area type="monotone" dataKey="resolved" stroke="#23966A" fill="url(#gr)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          ) : <EmptyState title="No trend data yet" description="Trends appear after scans record findings." />}
        </Panel>
        <Panel title="Severity distribution" subtitle={`${num(d?.findings?.total)} open findings`}>
          {sev.length ? (
            <div className="flex items-center gap-4">
              <ResponsiveContainer width="55%" height={190}>
                <PieChart><Pie data={sev} dataKey="value" innerRadius={52} outerRadius={80} paddingAngle={2} stroke="none">{sev.map((s) => <Cell key={s.name} fill={SEV_COLOR[s.name]} />)}</Pie><Tooltip contentStyle={{ borderRadius: 10, fontSize: 12 }} /></PieChart>
              </ResponsiveContainer>
              <div className="space-y-2">{sev.map((s) => <div key={s.name} className="flex items-center gap-2 text-[12.5px]"><span className="size-2 rounded-full" style={{ background: SEV_COLOR[s.name] }} /><span className="capitalize text-muted">{s.name}</span><span className="ml-auto font-semibold tabular-nums">{s.value}</span></div>)}</div>
            </div>
          ) : <EmptyState title="No open findings" description="Either the code is clean for the enabled analyzers, or no scan has run yet." />}
        </Panel>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Panel title="Risk by area" subtitle="Open findings by analyzer and severity" className="lg:col-span-2">
          {bySource.length ? (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={bySource} margin={{ left: -20, right: 6 }}>
                <CartesianGrid stroke="#EFECE5" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#77766F" }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 11, fill: "#A3A199" }} tickLine={false} axisLine={false} allowDecimals={false} />
                <Tooltip contentStyle={{ borderRadius: 10, border: "1px solid #E7E3DA", fontSize: 12 }} cursor={{ fill: "#F7F6F2" }} />
                {SEVERITIES.map((s) => <Bar key={s} dataKey={s} stackId="a" fill={SEV_COLOR[s]} radius={s === "info" ? [4, 4, 0, 0] : 0} />)}
              </BarChart>
            </ResponsiveContainer>
          ) : <EmptyState title="Nothing to chart yet" />}
        </Panel>
        <Panel title="Quick actions">
          <div className="grid gap-2">
            {[
              [Bug, "Run Bug Audit", () => run(["bug"], "Bug audit")],
              [ShieldCheck, "Scan Security", () => run(["security", "dependency"], "Security scan")],
              [FlaskConical, "Generate Tests", () => nav("/app/tests?new=1")],
              [GitPullRequest, "Review Changes", () => nav("/app/reviews?new=1")],
              [FileSearch, "Investigate Incident", () => nav("/app/investigations?new=1")],
            ].map(([I, l, fn]: any) => (
              <button key={l} disabled={!can("analysis.run")} onClick={fn} className="group flex items-center gap-3 rounded-xl border border-line bg-white px-3.5 py-2.5 text-left text-[13px] font-medium text-ink transition hover:border-amber/50 hover:shadow-[var(--shadow-pearl)] disabled:opacity-50">
                <I className="size-4 text-amber-deep" />{l}<ArrowRight className="ml-auto size-3.5 text-faint transition group-hover:translate-x-0.5" />
              </button>
            ))}
          </div>
        </Panel>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Panel title="Recommended actions" subtitle="Highest-severity open findings" pad={false} className="lg:col-span-2">
          {recommended.length ? recommended.map((f: any) => (
            <Link key={f.id} to={`/app/findings/${f.id}`} className="flex items-center gap-3 border-b border-line-2 px-5 py-3 last:border-0 hover:bg-ivory/50">
              <SeverityBadge severity={f.severity} /><span className="min-w-0 flex-1 truncate text-[13px] text-ink">{f.title}</span><span className="hidden truncate font-mono text-[11.5px] text-muted md:block">{f.file_path}{f.line ? `:${f.line}` : ""}</span>
            </Link>
          )) : <EmptyState title="No critical or high findings" description="Nothing urgent from the latest scans." />}
        </Panel>
        <Panel title="Recent analysis" pad={false}>
          {(d?.scans ?? []).slice(0, 7).map((s: any) => (
            <div key={s.id} className="flex items-center gap-3 border-b border-line-2 px-5 py-2.5 text-[12.5px] last:border-0">
              <StatusBadge status={s.status} /><span className="font-medium capitalize text-ink">{s.kind}</span><span className="text-muted">{s.summary?.findings != null ? `${s.summary.findings} findings` : ""}</span><span className="ml-auto text-faint">{timeAgo(s.finished_at ?? s.started_at)}</span>
            </div>
          ))}
          {!d?.scans?.length && <EmptyState title="No scans yet" />}
        </Panel>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Panel title="Recent commits" pad={false}>
          {(commits.data ?? []).slice(0, 6).map((c: any) => (
            <div key={c.sha} className="flex items-center gap-3 border-b border-line-2 px-5 py-2.5 text-[12.5px] last:border-0">
              <span className="font-mono text-[11.5px] text-amber-deep">{c.sha.slice(0, 7)}</span><span className="min-w-0 flex-1 truncate text-ink">{c.subject}</span><span className="text-faint">{c.author} · {timeAgo(c.date)}</span>
              {can("reviews.create") && <Link to={`/app/reviews?new=1&sha=${c.sha}`} className="text-[11.5px] text-muted hover:text-amber-deep">Review</Link>}
            </div>
          ))}
          {commits.data && !commits.data.length && <EmptyState title="No git history available" />}
        </Panel>
        <Panel title="Recent investigations" pad={false} actions={<Link to="/app/investigations"><Button size="sm" variant="ghost">All</Button></Link>}>
          {(d?.investigations ?? []).map((i: any) => <Link key={i.id} to={`/app/investigations/${i.id}`} className="flex items-center gap-3 border-b border-line-2 px-5 py-2.5 text-[12.5px] last:border-0 hover:bg-ivory/50"><StatusBadge status={i.status} /><span className="truncate text-ink">{i.title}</span><span className="ml-auto text-faint">{timeAgo(i.created_at)}</span></Link>)}
          {!d?.investigations?.length && <EmptyState title="No investigations yet" action={<Link to="/app/investigations?new=1"><Button size="sm">Start one</Button></Link>} />}
        </Panel>
      </div>
      {r?.languages && Object.keys(r.languages).length > 0 && (
        <Panel title="Languages" className="mt-4">
          <div className="flex h-2.5 overflow-hidden rounded-full ring-1 ring-line">{Object.entries(r.languages).sort((a: any, b: any) => b[1].loc - a[1].loc).slice(0, 8).map(([k, v]: any) => <div key={k} title={`${k}: ${v.loc} LOC`} style={{ flex: v.loc, background: `hsl(${(k.length * 47) % 360} 25% 60%)` }} />)}</div>
          <div className="mt-3 flex flex-wrap gap-2">{Object.entries(r.languages).sort((a: any, b: any) => b[1].loc - a[1].loc).slice(0, 10).map(([k, v]: any) => <Badge key={k}>{k} · {num(v.loc)}</Badge>)}</div>
        </Panel>
      )}
    </>
  );
}
