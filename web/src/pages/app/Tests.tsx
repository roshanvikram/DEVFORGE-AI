import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { FlaskConical, Plus, Play, Box, History, ShieldAlert } from "lucide-react";
import { get, post } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { NeedsRepo } from "../../components/AppShell";
import { PageHeader, Panel, Button, Modal, Field, Input, Textarea, Select, EmptyState, LoadingBlock, StatusBadge, Badge, Notice, CodeBlock, Toggle, Stat, Table, Markdown, cx } from "../../components/ui";
import { JobPanel } from "../../components/jobs";
import { timeAgo, duration, fmtDate } from "../../lib/format";

export function TestsPage() {
  return <NeedsRepo>{(repo) => <TestsView repo={repo} />}</NeedsRepo>;
}

function TestsView({ repo }: { repo: any }) {
  const [params, setParams] = useSearchParams();
  const { can } = useAuth();
  const caps = useQuery({ queryKey: ["capabilities"], queryFn: () => get("/system/capabilities") });
  const runs = useQuery({ queryKey: ["tests"], queryFn: () => get("/tests"), refetchInterval: (q) => ((q.state.data as any[])?.some((r) => ["queued", "running", "generating"].includes(r.status)) ? 2000 : false) });
  const [sel, setSel] = useState<string | null>(params.get("run"));
  const mine = (runs.data ?? []).filter((r: any) => r.repository_id === repo.id);
  useEffect(() => { if (!sel && mine[0]) setSel(mine[0].id); }, [mine.length]);
  const suite = async (install: boolean) => { try { const r = await post("/tests", { repositoryId: repo.id, kind: "suite", installDependencies: install }); setSel(r.id); toast.success("Test suite queued"); } catch (e: any) { toast.error(e.message); } };
  const sb = caps.data?.sandbox;
  return (
    <>
      <PageHeader eyebrow="Test Forge" icon={<FlaskConical className="size-6 text-amber-deep" />} title="Test generation & execution" description="Select code → analyse branches and edge cases → generate scenarios and tests → execute in an isolated sandbox → parse results → analyse failures. Success is only reported after tests actually run."
        actions={can("tests.run") && <><Button icon={<Play className="size-4" />} onClick={() => suite(false)}>Run existing suite</Button><Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setParams({ new: "1" })}>Generate tests</Button></>} />
      {sb && <div className="mb-4">{sb.mode === "disabled" ? <Notice tone="amber" icon={<ShieldAlert className="size-4 text-amber-deep" />}>Sandboxed execution is unavailable on this server ({sb.reason}). Tests can be generated but will be marked “not executed”.</Notice> : <Notice tone="success" icon={<Box className="size-4 text-success" />}>Isolation: <b>{sb.mode === "macos" ? "macOS sandbox-exec" : "Docker"}</b> — no network during test execution, writes confined to a throwaway workdir, credentials directories unreadable.{!caps.data?.ai.configured && " · AI provider not configured: Test Forge will derive scenarios statically but cannot write test code."}</Notice>}</div>}
      <div className="grid gap-4 xl:grid-cols-[360px_1fr]">
        <Panel title="Runs" pad={false}>
          {runs.isLoading ? <div className="p-4"><LoadingBlock /></div> : !mine.length ? <EmptyState icon={<FlaskConical className="size-5" />} title="No test runs yet" /> : mine.map((r: any) => (
            <button key={r.id} onClick={() => setSel(r.id)} className={cx("w-full border-b border-line-2 px-4 py-3 text-left last:border-0 hover:bg-ivory/50", sel === r.id && "bg-amber-soft/30")}>
              <div className="flex items-center gap-2"><StatusBadge status={r.status} /><Badge>{r.kind}</Badge>{r.framework && <Badge>{r.framework}</Badge>}<span className="ml-auto text-[11px] text-faint">{timeAgo(r.created_at)}</span></div>
              <div className="mt-1 truncate font-mono text-[12px] text-ink">{r.target?.path ?? "full suite"}{r.target?.symbol ? ` › ${r.target.symbol}` : ""}</div>
              {r.passed != null && <div className="mt-1 text-[12px]"><span className="text-success">{r.passed} passed</span> · <span className={r.failed ? "text-danger" : "text-muted"}>{r.failed} failed</span>{r.skipped ? ` · ${r.skipped} skipped` : ""}</div>}
            </button>
          ))}
        </Panel>
        {sel ? <RunDetail id={sel} /> : <Panel><EmptyState title="Select a run" /></Panel>}
      </div>
      <GenerateModal repo={repo} open={params.get("new") === "1"} onClose={() => setParams({})} onCreated={(id) => setSel(id)} initialPath={params.get("path")} />
    </>
  );
}

function GenerateModal({ repo, open, onClose, onCreated, initialPath }: { repo: any; open: boolean; onClose: () => void; onCreated: (id: string) => void; initialPath: string | null }) {
  const [path, setPath] = useState(initialPath ?? "");
  const [symbol, setSymbol] = useState("");
  const [instructions, setInstructions] = useState("");
  const [install, setInstall] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (initialPath) setPath(initialPath); }, [initialPath]);
  const tree = useQuery({ queryKey: ["tree", repo.id, repo.stats?.files], queryFn: () => get(`/repositories/${repo.id}/tree`), enabled: open });
  const syms = useQuery({ queryKey: ["file", repo.id, path], queryFn: () => get(`/repositories/${repo.id}/file?path=${encodeURIComponent(path)}`), enabled: open && !!path, retry: false });
  const preview = useQuery({ queryKey: ["test-preview", repo.id, path, symbol], queryFn: () => post("/tests/preview", { repositoryId: repo.id, path, symbol: symbol || undefined }), enabled: open && !!path && !!syms.data, retry: false });
  const candidates = (tree.data ?? []).filter((f: any) => !f.is_test && ["typescript", "javascript", "python"].includes(f.language));
  return (
    <Modal open={open} onClose={onClose} width={760} title="Generate tests" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!path} onClick={async () => { setBusy(true); try { const r = await post("/tests", { repositoryId: repo.id, kind: "generate", path, symbol: symbol || undefined, instructions: instructions || undefined, installDependencies: install }); onCreated(r.id); onClose(); toast.success("Test generation started"); } catch (e: any) { toast.error(e.message); } finally { setBusy(false); } }}>Generate & execute</Button></>}>
      <div className="space-y-4">
        <Field label="1 · Select code"><Select className="w-full" value={path} onChange={(e) => { setPath(e.target.value); setSymbol(""); }}><option value="">Choose a source file…</option>{candidates.map((f: any) => <option key={f.path} value={f.path}>{f.path}</option>)}</Select></Field>
        {syms.data && <Field label="Function (optional)"><Select className="w-full" value={symbol} onChange={(e) => setSymbol(e.target.value)}><option value="">Whole file</option>{syms.data.symbols.filter((s: any) => ["function", "method", "component"].includes(s.kind)).map((s: any) => <option key={s.id} value={s.name}>{s.parent ? `${s.parent}.` : ""}{s.name} (line {s.line}, complexity {s.complexity})</option>)}</Select></Field>}
        {preview.data && (
          <div className="rounded-xl border border-line bg-ivory/40 p-4">
            <div className="text-[12px] font-semibold uppercase tracking-[0.08em] text-muted">2–4 · Static analysis preview</div>
            <div className="mt-2 flex flex-wrap gap-2 text-[12px]"><Badge tone="amber">{preview.data.framework.framework}</Badge><span className="text-muted">{preview.data.framework.reason}</span></div>
            <div className="mt-3 grid gap-3 md:grid-cols-2 text-[12.5px]">
              <div><div className="font-medium text-ink">Branches ({preview.data.analysis.branchCount})</div><ul className="mt-1 space-y-0.5 font-mono text-[11.5px] text-ink-2">{preview.data.analysis.branches.slice(0, 8).map((b: any) => <li key={b.line} className="truncate">L{b.line}: {b.condition}</li>)}</ul></div>
              <div><div className="font-medium text-ink">Edge cases</div><ul className="mt-1 space-y-0.5 text-[11.5px] text-ink-2">{preview.data.analysis.edgeCases.slice(0, 8).map((e: string) => <li key={e} className="truncate">• {e}</li>)}</ul></div>
            </div>
          </div>
        )}
        <Field label="Additional instructions (optional)"><Textarea rows={2} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="e.g. Mock the database client; focus on invalid input." /></Field>
        <Toggle checked={install} onChange={setInstall} label="Install dependencies inside the sandbox first (network on for install only; lifecycle scripts disabled)" />
      </div>
    </Modal>
  );
}

function RunDetail({ id }: { id: string }) {
  const q = useQuery({ queryKey: ["test", id], queryFn: () => get(`/tests/${id}`), refetchInterval: (qq) => (["queued", "running", "generating"].includes((qq.state.data as any)?.status) ? 1500 : false) });
  if (q.isLoading) return <Panel><LoadingBlock /></Panel>;
  const t = q.data;
  if (!t) return null;
  const sc = t.scenarios ?? {};
  const active = ["queued", "running", "generating"].includes(t.status);
  return (
    <div className="space-y-4">
      <Panel title={<span className="flex items-center gap-2"><span className="font-mono text-[13px]">{t.target?.path ?? "Full test suite"}</span>{t.target?.symbol && <Badge>{t.target.symbol}</Badge>}</span>} subtitle={`${t.kind} · ${t.framework ?? "detecting framework"} · ${fmtDate(t.created_at)}`} actions={<StatusBadge status={t.status} />}>
        {active && t.job_id && <JobPanel jobId={t.job_id} compact />}
        {t.error && <Notice tone={["scenarios_only", "not_executed"].includes(t.status) ? "info" : "danger"}>{t.error}</Notice>}
        {t.passed != null && (
          <div className="mt-2 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Passed" value={t.passed} tone="success" />
            <Stat label="Failed" value={t.failed} tone={t.failed ? "danger" : undefined} />
            <Stat label="Skipped" value={t.skipped ?? 0} />
            <Stat label="Duration" value={duration(t.duration_ms)} sub={t.sandbox ? `sandbox: ${t.sandbox}` : undefined} />
          </div>
        )}
        {t.command && <div className="mt-3 rounded-lg bg-ivory/60 px-3 py-2 font-mono text-[11.5px] text-ink-2 ring-1 ring-line">$ {t.command}{t.exit_code != null && <span className="text-muted"> → exit {t.exit_code}</span>}</div>}
      </Panel>
      {(sc.branches || sc.aiScenarios) && (
        <Panel title="Scenarios" subtitle={sc.source === "static+ai" ? "Static analysis + AI" : "Static analysis"}>
          <div className="grid gap-4 md:grid-cols-2">
            <div><div className="mb-2 text-[12px] font-semibold text-muted">Branches & errors</div>{(sc.scenarios ?? []).map((s: any, i: number) => <div key={i} className="mb-1.5 text-[12.5px]"><Badge className="mr-2">{s.kind}</Badge>{s.title}</div>)}</div>
            <div><div className="mb-2 text-[12px] font-semibold text-muted">Edge cases</div>{(sc.edgeCases ?? []).map((e: string) => <div key={e} className="mb-1 text-[12.5px] text-ink-2">• {e}</div>)}</div>
          </div>
          {sc.aiScenarios?.length > 0 && <div className="mt-4"><div className="mb-2 text-[12px] font-semibold text-muted">AI-generated scenarios</div>{sc.aiScenarios.map((s: any, i: number) => <div key={i} className="mb-1.5 text-[12.5px]"><Badge tone="info" className="mr-2">{s.kind}</Badge>{s.title} <span className="text-muted">— {s.rationale}</span></div>)}</div>}
          {sc.notes && <p className="mt-3 text-[12.5px] text-muted">{sc.notes}</p>}
        </Panel>
      )}
      {t.generated_files?.map((f: any) => <Panel key={f.path} title={<span className="font-mono text-[13px]">{f.path}</span>} subtitle="Generated test file (written only to the sandbox copy, never to your repository)"><CodeBlock code={f.content} language={f.path.endsWith(".py") ? "python" : "typescript"} maxHeight={420} /></Panel>)}
      {t.analysis && <Panel title="Failure analysis"><Markdown>{t.analysis}</Markdown></Panel>}
      {(t.stdout || t.stderr) && (
        <Panel title="Runner output">
          <pre className="scroll-thin max-h-80 overflow-auto rounded-lg bg-[var(--color-code)] p-3 font-mono text-[11.5px] text-ink-2 ring-1 ring-line">{(t.stdout ?? "").slice(-20000)}{t.stderr ? `\n--- stderr ---\n${t.stderr.slice(-10000)}` : ""}</pre>
        </Panel>
      )}
    </div>
  );
}

export function RegressionsPage() {
  const runs = useQuery({ queryKey: ["tests"], queryFn: () => get("/tests") });
  const a = useQuery({ queryKey: ["analytics", 90], queryFn: () => get("/analytics?days=90") });
  const reviews = useQuery({ queryKey: ["reviews"], queryFn: () => get("/reviews") });
  const executed = (runs.data ?? []).filter((r: any) => r.passed != null);
  const regressions = executed.filter((r: any, i: number) => r.failed > 0 && executed.slice(i + 1).some((p: any) => p.repository_id === r.repository_id && (p.target?.path ?? "suite") === (r.target?.path ?? "suite") && p.failed === 0));
  const breaking = (reviews.data ?? []).filter((r: any) => r.risk_score >= 50);
  return (
    <>
      <PageHeader eyebrow="Regression Analysis" icon={<History className="size-6 text-amber-deep" />} title="Regressions" description="Tests that previously passed and now fail, high-risk changes from code review, and test outcomes over time — all from recorded runs." />
      <div className="mb-4 grid gap-3 md:grid-cols-3">
        <Stat label="Executed test runs (90d)" value={executed.length} />
        <Stat label="Detected regressions" value={regressions.length} tone={regressions.length ? "danger" : "success"} sub="pass → fail on the same target" />
        <Stat label="High-risk reviews" value={breaking.length} tone={breaking.length ? "amber" : undefined} sub="risk score ≥ 50" />
      </div>
      <Panel title="Test outcomes over time" className="mb-4">
        {a.data?.tests?.length ? (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={a.data.tests} margin={{ left: -20 }}><CartesianGrid stroke="var(--color-line-2)" vertical={false} /><XAxis dataKey="day" tick={{ fontSize: 11, fill: "var(--color-faint)" }} axisLine={false} tickLine={false} /><YAxis tick={{ fontSize: 11, fill: "var(--color-faint)" }} axisLine={false} tickLine={false} allowDecimals={false} /><Tooltip contentStyle={{ borderRadius: 10, fontSize: 12 }} /><Bar dataKey="passed" stackId="a" fill="#23966A" /><Bar dataKey="failed" stackId="a" fill="#D94C4C" radius={[4, 4, 0, 0]} /></BarChart>
          </ResponsiveContainer>
        ) : <EmptyState title="No executed test runs yet" description="Run tests in Test Forge to build history." action={<Link to="/app/tests"><Button>Open Test Forge</Button></Link>} />}
      </Panel>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Regressions" pad={false}>{regressions.length ? regressions.map((r: any) => <Link key={r.id} to={`/app/tests?run=${r.id}`} className="flex items-center gap-3 border-b border-line-2 px-5 py-2.5 last:border-0 hover:bg-ivory/50"><StatusBadge status={r.status} /><span className="truncate font-mono text-[12px]">{r.target?.path ?? "suite"}</span><span className="ml-auto text-[12px] text-danger">{r.failed} failing</span></Link>) : <EmptyState title="No regressions detected" />}</Panel>
        <Panel title="High-risk changes" pad={false}>{breaking.length ? breaking.map((r: any) => <Link key={r.id} to={`/app/reviews/${r.id}`} className="flex items-center gap-3 border-b border-line-2 px-5 py-2.5 last:border-0 hover:bg-ivory/50"><Badge tone="amber">risk {r.risk_score}</Badge><span className="truncate text-[13px]">{r.title}</span><span className="ml-auto text-[11.5px] text-faint">{timeAgo(r.created_at)}</span></Link>) : <EmptyState title="No high-risk reviews" />}</Panel>
      </div>
      <Panel title="All executed runs" pad={false} className="mt-4">
        {executed.length ? <Table head={["Target", "Repository", "Result", "Duration", "When"]}>{executed.map((r: any) => <tr key={r.id}><td className="px-4 py-2 font-mono text-[12px]"><Link to={`/app/tests?run=${r.id}`}>{r.target?.path ?? "full suite"}</Link></td><td className="px-4 py-2 text-muted">{r.repository}</td><td className="px-4 py-2"><span className="text-success">{r.passed}✓</span> <span className={r.failed ? "text-danger" : "text-muted"}>{r.failed}✗</span></td><td className="px-4 py-2 text-muted">{duration(r.duration_ms)}</td><td className="px-4 py-2 text-muted">{timeAgo(r.created_at)}</td></tr>)}</Table> : <EmptyState title="No runs" />}
      </Panel>
    </>
  );
}
